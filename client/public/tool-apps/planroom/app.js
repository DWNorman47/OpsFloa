/* Plan Room — viewer + markup + measure (M1 viewer core + M2 markups).
 * Built on the shared plan-tools engine (../shared/engine-*.js). Local-first:
 * projects live in this browser (IndexedDB 'planroom'), documents dedup by
 * content hash, markups live inside the project data (no server tables).
 * See docs/plans/plan-viewer-markup.md.
 */

import { createViewport } from '../shared/engine-view.js?v=2';
import { createStore, randId, hashBytes } from '../shared/engine-store.js?v=1';
import { openDoc, bytesToBase64, base64ToBytes, defaultRenderScale } from '../shared/engine-doc.js?v=1';
import { createModals, esc, fmt, money } from '../shared/engine-ui.js?v=2';
import { distToPolyline, pointSegDist, simplifyPts, polyLengthFt, polygonAreaFt2, polygonPerimeterFt, pointInPolygon, dist, alignApply } from '../shared/engine-measure.js?v=1';
import polygonClipping from '../shared/polygon-clipping.js?v=1';

pdfjsLib.GlobalWorkerOptions.workerSrc = '../shared/pdf.worker.min.js';

// Token handoff: the main app opens this tool in a noopener tab that can't reach
// the opener's sessionStorage, so during superadmin login-as it can't see the
// impersonation token. The opener stashes that token in a one-time localStorage
// entry keyed by a URL nonce (#h=…); pick it up into OUR tab-scoped
// sessionStorage, then scrub both the entry and the nonce from the URL. Runs
// before any authenticated call (toolToken reads sessionStorage first).
(function pickupTokenHandoff() {
  const m = /[#&]h=([a-z0-9]+)/i.exec(location.hash || '');
  if (!m) return;
  const key = 'tc_handoff_' + m[1];
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const { t, exp } = JSON.parse(raw);
      if (t && (!exp || Date.now() < exp)) sessionStorage.setItem('tc_token', t);
    }
    localStorage.removeItem(key);
  } catch (_) { /* storage blocked / bad json */ }
  try { history.replaceState(null, '', location.pathname + location.search); } catch (_) {}
})();

const $ = id => document.getElementById(id);

/* ============================== State ============================== */

const state = {
  projectId: null,
  projectName: 'Project 1',
  doc: null,        // engine-doc handle (pdf or image)
  docKey: null,     // content hash → IndexedDB 'files'
  docName: null,
  docType: null,
  page: 1,
  markups: [],      // markup objects; geometry in world/base px (see MK kinds)
  scales: {},       // pageNum -> ftPerPx (per-sheet calibration; measures recompute live)
  scaleBars: {},    // pageNum -> { a:{x,y}, b:{x,y}, feet } — the editable on-canvas calibration bar (source of ftPerPx)
  serverId: null,     // takeoff_projects id when linked to a company-shared copy
  serverVersion: null, // its optimistic-concurrency version at open/last save
  roofPitch: 6,     // takeoff layer: main roof pitch (rise/12) for edge factors
  roofWaste: 12,    // takeoff layer: waste % applied to squares
  roofPrices: {},   // takeoff layer: unit-price overrides by bid-line key
  roofOP: 15,       // takeoff layer: overhead & profit %
  // takeoff layer: earthwork/cut-fill (sitework pack). existing & proposed are
  // page numbers; align maps proposed-page px -> existing-page px at compute.
  earthwork: { existingPage: null, proposedPage: null, align: { a: 1, b: 0, e: 0, f: 0 },
    gridFt: 5, shrink: 15, swell: 25, truckCap: 12, interval: 1, result: null },
  trade: '',        // takeoff trade mode: '' (markup only) | 'roofing' | 'dirt' | 'drywall' | 'flooring' | 'framing' | 'esc' | 'striping' | 'siding' | 'demo' | 'fence' | 'landscape'
  bidMeta: {},      // per-bid project / prepared-by / date overrides
  estimateId: null, // OpsFloa estimate this project was launched from (?estimate=), for pushing pricing back
  // drywall & paint pack settings (project-wide)
  drywall: { wallHeight: 9, sheetSF: 32, waste: 10, coverage: 375, coats: 2, finish: 'L4', texture: 'none', insul: 'none' },
  // flooring & tile pack settings (project-wide)
  flooring: { waste: 10, underlay: 'none', tileSize: '12x12', groutJoint: '3/16', thinsetCov: 95 },
  // framing & lumber pack settings (project-wide)
  framing: { spacing: 16, height: 9, topPlates: 2, sheathWaste: 10 },
  // erosion & sediment control pack settings (project-wide; the area rates are
  // unused until E3 but the shape is fixed here so persistence is wired once)
  esc: { entranceDepth: 6, stoneDensity: 105, seedRate: 200, mulchRate: 2, blanketWaste: 10, riprapDepth: 12 },
  // striping & signage pack settings (project-wide; the paint fields go live in
  // S3 but the shape is fixed here so persistence is wired once)
  striping: { coverage4in: 320, beadRate: 6, coats: 1 },
  // siding / gutters / insulation pack settings (project-wide; the insulation
  // fields go live in Si3 but the shape is fixed here so persistence is wired once)
  siding: { waste: 10, insulWaste: 5, battCoverage: 88 },
  // demolition pack settings (project-wide). truckCap is deliberately its own
  // rather than reading state.earthwork.truckCap — coupling them would mean
  // changing the earthwork setting silently re-prices the demo bid.
  demo: { swell: 50, truckCap: 12, thickAsphalt: 3, thickConcrete: 6, thickSidewalk: 4, thickGravel: 6 },
  // fencing & guardrail pack settings (project-wide). Post SPACING is NOT here —
  // it belongs to the fence type (chain link 10ft, vinyl 6ft, guardrail 6.25ft),
  // so one project-wide number would be wrong on every mixed job.
  fence: { holeDia: 10, holeDepth: 30, bagCF: 0.45 },
  // landscape & irrigation pack settings (project-wide). Depths are PER TYPE —
  // a 3" mulch bed and a 6" soil-prep bed on the same plan are normal.
  landscape: { mulchDepth: 3, rockDepth: 3, bedDepth: 6, rockDensity: 100, sodWaste: 5, seedRate: 5 },
};
let curDwSides = 2;  // 1 = perimeter/against structure, 2 = interior partition (both faces)
let curCeilType = 'drywall';  // ceiling type for new ceilings: drywall | act24 | act22 (ACT = suspended grid)
const OPENING_DEDUCT = { door: 21, window: 15, opening: 15 }; // SF deducted from wall per opening
const OPENING_LABEL = { door: 'Door', window: 'Window', opening: 'Opening' };
const TRIM_LABEL = { base: 'Base', crown: 'Crown', chair: 'Chair rail' };
const CEIL_LABEL = { drywall: 'Drywall', act24: 'ACT 2×4', act22: 'ACT 2×2' };
let curFloorType = 'tile'; // material for new flooring rooms
const FLOOR_LABEL = { tile: 'Tile', lvp: 'LVP / vinyl plank', laminate: 'Laminate', hardwood: 'Hardwood', carpet: 'Carpet', vinyl: 'Sheet vinyl', other: 'Other' };
const FLOOR_PRICE = { tile: 9, lvp: 5.5, laminate: 4, hardwood: 9, carpet: 3.5, vinyl: 3.5, other: 5 }; // $/SF installed default
let curTransType = 'reducer'; // type for new flooring transitions
const TRANS_LABEL = { threshold: 'Threshold', reducer: 'Reducer', tmolding: 'T-molding', stairnose: 'Stair nose', seam: 'Transition strip', other: 'Other' };
const TRANS_PRICE = { threshold: 8, reducer: 6, tmolding: 5, stairnose: 10, seam: 4, other: 5 }; // $/LF
const UNDERLAY_LABEL = { none: 'None', foam: 'Foam underlayment', cork: 'Cork underlayment', cement: 'Cement board', ditra: 'Uncoupling membrane' };
const UNDERLAY_PRICE = { foam: 0.5, cork: 0.9, cement: 1.5, ditra: 2.2 }; // $/SF
const TILE_SIZE = { '6x6': [6, 6], '12x12': [12, 12], '12x24': [12, 24], '18x18': [18, 18], '24x24': [24, 24], '6x24': [6, 24] }; // inches [L,W]
const GROUT_JOINT = { '1/16': 0.0625, '1/8': 0.125, '3/16': 0.1875, '1/4': 0.25, '3/8': 0.375 }; // inches
const TILE_THICK_IN = 0.375; // assumed floor-tile thickness for grout coverage
let curFramSize = '2x4'; // stud size for new framing walls
const FRAM_SIZE_LABEL = { '2x4': '2×4', '2x6': '2×6', '2x8': '2×8' };
const FRAM_SIZE_BF = { '2x4': 0.667, '2x6': 1.0, '2x8': 1.333 }; // board-feet per LF (nominal)
const FRAM_STUD_PRICE = { '2x4': 3.5, '2x6': 5.5, '2x8': 8 }; // $/stud
const FRAM_PLATE_PRICE = { '2x4': 0.9, '2x6': 1.4, '2x8': 2 }; // $/LF of plate stock
let curFopenType = 'door'; // opening type for new framed openings
const FOPEN_LABEL = { door: 'Door', window: 'Window' };
const FOPEN_W = { door: 3, window: 4 }; // default rough-opening width (ft)
let curSheathType = 'osb716'; // sheathing type for new sheathing areas
const SHEATH_LABEL = { osb716: 'OSB 7/16"', ply12: 'Plywood 1/2"', ply58: 'Plywood 5/8"', zip: 'ZIP System' };
const SHEATH_PRICE = { osb716: 15, ply12: 30, ply58: 38, zip: 25 }; // $/sheet (4×8 = 32 SF)
let curEscLine = 'silt'; // BMP type for new ESC linear runs
const ESC_LINE_KINDS = ['silt', 'supersilt', 'sock', 'wattle', 'treeprot', 'berm', 'curtain'];
const ESC_LINE_LABEL = {
  silt: 'Silt fence', supersilt: 'Super silt fence', sock: 'Compost sock', wattle: 'Straw wattle',
  treeprot: 'Tree protection fence', berm: 'Diversion berm', curtain: 'Turbidity curtain',
};
// $/LF installed — ESC is bid at installed unit prices, so labor is baked in
let curEscItem = 'inletdrop'; // BMP type for new ESC point controls
const ESC_ITEM_KINDS = ['inletdrop', 'inletcurb', 'checkdam', 'washout', 'dewater'];
const ESC_ITEM_LABEL = {
  inletdrop: 'Inlet protection — drop', inletcurb: 'Inlet protection — curb',
  checkdam: 'Rock check dam', washout: 'Concrete washout', dewater: 'Dewatering bag',
};
const ESC_ITEM_PRICE = { inletdrop: 150, inletcurb: 200, checkdam: 350, washout: 800, dewater: 250 }; // $/EA installed
let curEscArea = 'entrance'; // type for new ESC stabilized areas
const ESC_AREA_KINDS = ['entrance', 'blanket', 'seed', 'riprap'];
const ESC_AREA_LABEL = {
  entrance: 'Construction entrance', blanket: 'Erosion blanket',
  seed: 'Hydroseed / seed & mulch', riprap: 'Riprap / outlet protection',
};
// unit conversions for the area material math
const SF_PER_SY = 9, CF_PER_CY = 27, SF_PER_ACRE = 43560, LB_PER_TON = 2000;
let curStrpLine = 'line4'; // stripe type for new runs
const STRP_LINE_KINDS = ['line4', 'line6', 'line8', 'xwalk', 'stopbar', 'hatch'];
const STRP_LINE_LABEL = {
  line4: '4" line', line6: '6" line', line8: '8" line',
  xwalk: '12" crosswalk', stopbar: '24" stop bar', hatch: 'Hatching / diagonal',
};
const STRP_LINE_WIDTH = { line4: 4, line6: 6, line8: 8, xwalk: 12, stopbar: 24, hatch: 4 }; // paint width (in) — drives S3 gallons
const STRP_LINE_PRICE = { line4: 0.35, line6: 0.5, line8: 0.7, xwalk: 1.1, stopbar: 2.25, hatch: 0.4 }; // $/LF installed
let curStrpStall = 'standard'; // stall type for new counts
const STRP_STALL_KINDS = ['standard', 'compact', 'ada', 'adavan'];
const STRP_STALL_LABEL = { standard: 'Standard stall', compact: 'Compact stall', ada: 'ADA accessible stall', adavan: 'ADA van-accessible stall' };
const STRP_STALL_PRICE = { standard: 5, compact: 5, ada: 45, adavan: 55 }; // $/EA installed (stall price includes painting its own lines)
const STRP_STALL_ADA = { ada: true, adavan: true }; // counts toward the ADA tally
let curStrpMark = 'arrow'; // marking/sign type for new counts
const STRP_MARK_KINDS = ['arrow', 'only', 'adasym', 'sign', 'wheelstop', 'bollard'];
const STRP_MARK_LABEL = {
  arrow: 'Directional arrow', only: 'ONLY / word legend', adasym: 'ADA symbol',
  sign: 'Sign (post + panel)', wheelstop: 'Wheel stop', bollard: 'Bollard',
};
const STRP_MARK_PRICE = { arrow: 35, only: 45, adasym: 40, sign: 165, wheelstop: 55, bollard: 240 }; // $/EA installed
let curSidMat = 'vinyl'; // material for new siding walls
const SID_MAT_KINDS = ['vinyl', 'fclap', 'fcpanel', 'woodlap', 'stucco', 'brick', 'stone'];
const SID_MAT_LABEL = {
  vinyl: 'Vinyl lap', fclap: 'Fiber cement lap', fcpanel: 'Fiber cement panel',
  woodlap: 'Wood lap', stucco: 'Stucco', brick: 'Brick veneer', stone: 'Stone veneer',
};
const SID_MAT_PRICE = { vinyl: 4.5, fclap: 8.5, fcpanel: 8, woodlap: 9.5, stucco: 9, brick: 18, stone: 28 }; // $/SF installed
let curSidOpen = 'window'; // opening type for new counts
const SID_OPEN_KINDS = ['window', 'door', 'garage'];
const SID_OPEN_LABEL = { window: 'Window', door: 'Door', garage: 'Garage door' };
const SID_OPEN_DEDUCT = { window: 15, door: 21, garage: 112 }; // SF removed from the wall per opening
// An opening deducts SF but still costs money: cutting and wrapping siding around
// it is more work per foot than the field. Priced EA on top of the deduction.
const SID_OPEN_PRICE = { window: 65, door: 75, garage: 180 }; // $/EA trim + wrap
const SF_PER_SQUARE = 100;
let curSidGut = 'k5'; // gutter type for new runs
const SID_GUT_KINDS = ['k5', 'k6', 'half', 'downspout', 'fascia'];
const SID_GUT_LABEL = {
  k5: '5" K-style gutter', k6: '6" K-style gutter', half: 'Half-round gutter',
  downspout: 'Downspout', fascia: 'Fascia wrap',
};
const SID_GUT_PRICE = { k5: 9, k6: 12, half: 18, downspout: 11, fascia: 7 }; // $/LF installed
let curSidIns = 'battR13'; // insulation type for new areas
const SID_INS_KINDS = ['battR13', 'battR19', 'battR21', 'blownR38', 'blownR49', 'foam'];
const SID_INS_LABEL = {
  battR13: 'Batt R-13 (2×4 wall)', battR19: 'Batt R-19 (2×6 wall)', battR21: 'Batt R-21 (2×6 wall)',
  blownR38: 'Blown attic R-38', blownR49: 'Blown attic R-49', foam: 'Spray foam',
};
const SID_INS_PRICE = { battR13: 0.95, battR19: 1.35, battR21: 1.55, blownR38: 1.6, blownR49: 2.05, foam: 3.6 }; // $/SF installed
// Batts come in bags; blown/foam are bid straight by SF, so only the batts get a
// bag count. Coverage is the project setting (state.siding.battCoverage).
const SID_INS_BAGGED = { battR13: true, battR19: true, battR21: true };
let curDmArea = 'bldgWood'; // type for new demo areas
const DM_AREA_KINDS = ['bldgWood', 'bldgMasonry', 'bldgSteel', 'asphalt', 'concrete', 'sidewalk', 'gravel'];
const DM_AREA_LABEL = {
  bldgWood: 'Building — wood frame', bldgMasonry: 'Building — masonry', bldgSteel: 'Building — steel',
  asphalt: 'Asphalt pavement', concrete: 'Concrete slab / paving', sidewalk: 'Sidewalk', gravel: 'Gravel / base',
};
// A building is mostly AIR: footprint x height would be wildly wrong (a 1,000 SF
// house is not 444 CY of debris). These are empirical CY of loose debris per SF
// of footprint, bulking already included. Steel is lowest — the frame goes to
// scrap rather than the pile.
const DM_AREA_CYSF = { bldgWood: 0.25, bldgMasonry: 0.45, bldgSteel: 0.2 };
// Pavements are solid, so they convert by thickness and then swell. Key = the
// state.demo setting holding that type's default thickness (in).
const DM_AREA_THICK_KEY = { asphalt: 'thickAsphalt', concrete: 'thickConcrete', sidewalk: 'thickSidewalk', gravel: 'thickGravel' };
const DM_AREA_DENSITY = { // lb/ft³ in place, for the tonnage line
  bldgWood: 25, bldgMasonry: 65, bldgSteel: 20,
  asphalt: 145, concrete: 150, sidewalk: 150, gravel: 135,
};
const DM_AREA_PRICE = { // $/SF demo (machine + labor; haul is its own line)
  bldgWood: 4.5, bldgMasonry: 7, bldgSteel: 6,
  asphalt: 1.1, concrete: 1.9, sidewalk: 1.6, gravel: 0.6,
};
const DM_HAUL_PRICE = 95; // $/load
const isDmBuilding = k => DM_AREA_CYSF[k] != null;
let curDmLine = 'curb'; // type for new linear removals
const DM_LINE_KINDS = ['curb', 'walkstrip', 'pipe', 'fence', 'guardrail'];
const DM_LINE_LABEL = {
  curb: 'Curb & gutter', walkstrip: 'Sidewalk strip', pipe: 'Pipe removal',
  fence: 'Fence removal', guardrail: 'Guardrail removal',
};
const DM_LINE_PRICE = { curb: 6.5, walkstrip: 4.5, pipe: 12, fence: 4, guardrail: 9 }; // $/LF installed (removal + haul)
let curDmItem = 'tree'; // type for new item removals
const DM_ITEM_KINDS = ['tree', 'lightpole', 'sign', 'catchbasin', 'manhole', 'hydrant'];
const DM_ITEM_LABEL = {
  tree: 'Tree removal', lightpole: 'Light pole', sign: 'Sign',
  catchbasin: 'Catch basin', manhole: 'Manhole', hydrant: 'Fire hydrant',
};
const DM_ITEM_PRICE = { tree: 750, lightpole: 425, sign: 85, catchbasin: 650, manhole: 900, hydrant: 700 }; // $/EA installed
let curFnLine = 'chain6'; // type for new fence runs
const FN_LINE_KINDS = ['chain4', 'chain6', 'wood6', 'vinyl6', 'ornamental', 'farm', 'guardrail', 'cable'];
const FN_LINE_LABEL = {
  chain4: 'Chain link 4\u2032', chain6: 'Chain link 6\u2032', wood6: 'Wood privacy 6\u2032',
  vinyl6: 'Vinyl privacy 6\u2032', ornamental: 'Ornamental aluminum', farm: 'Farm / field fence',
  guardrail: 'Guardrail (W-beam)', cable: 'Cable rail',
};
// Post spacing is a property of the TYPE (ft between posts) — 6.25 for W-beam
// guardrail is the standard post spacing, not a rounded guess.
const FN_LINE_SPACING = { chain4: 10, chain6: 10, wood6: 8, vinyl6: 6, ornamental: 6, farm: 12, guardrail: 6.25, cable: 8 };
const FN_LINE_PRICE = { chain4: 18, chain6: 26, wood6: 32, vinyl6: 42, ornamental: 55, farm: 9, guardrail: 38, cable: 48 }; // $/LF INSTALLED (posts, rails, fabric, concrete all inside)
let curFnGate = 'walk'; // type for new gates
const FN_GATE_KINDS = ['walk', 'drive', 'slide', 'endtreat'];
const FN_GATE_LABEL = { walk: 'Walk gate', drive: 'Double drive gate', slide: 'Cantilever slide gate', endtreat: 'Guardrail end treatment' };
const FN_GATE_PRICE = { walk: 385, drive: 1250, slide: 4200, endtreat: 2600 }; // $/EA installed
let curLsArea = 'mulch'; // type for new landscape areas
const LS_AREA_KINDS = ['mulch', 'sod', 'seed', 'rock', 'bed'];
const LS_AREA_LABEL = {
  mulch: 'Mulch bed', sod: 'Sod', seed: 'Lawn seed',
  rock: 'Decorative rock', bed: 'Planting bed (soil prep)',
};
// Unlike the last four packs, landscape bids in the MATERIAL's own unit — mulch
// is bought by the CY, rock by the ton, sod by the SY. Quoting mulch per SF
// would be the unnatural choice here, so the materials math IS the bid.
const LS_AREA_UNIT = { mulch: 'CY', sod: 'SY', seed: 'SF', rock: 'ton', bed: 'CY' };
const LS_AREA_PRICE = { mulch: 55, sod: 6, seed: 0.12, rock: 95, bed: 45 }; // $ per the unit above, installed
let curLsPlant = 'shrub5'; // type for new plant counts
const LS_PLANT_KINDS = ['tree2', 'tree3', 'shrub5', 'shrub3', 'perennial', 'grass'];
const LS_PLANT_LABEL = {
  tree2: 'Tree — 2″ cal.', tree3: 'Tree — 3″ cal.', shrub5: 'Shrub — 5 gal',
  shrub3: 'Shrub — 3 gal', perennial: 'Perennial — 1 gal', grass: 'Ornamental grass',
};
const LS_PLANT_PRICE = { tree2: 450, tree3: 750, shrub5: 65, shrub3: 42, perennial: 18, grass: 16 }; // $/EA installed
let curLsLine = 'lateral'; // type for new irrigation runs
const LS_LINE_KINDS = ['main', 'lateral', 'drip', 'sleeve', 'edging'];
const LS_LINE_LABEL = {
  main: 'Mainline 1″', lateral: 'Lateral 3/4″', drip: 'Drip tubing',
  sleeve: 'Sleeve under paving', edging: 'Steel edging',
};
const LS_LINE_PRICE = { main: 4.5, lateral: 2.25, drip: 1.6, sleeve: 9, edging: 6 }; // $/LF installed
let curLsHead = 'spray'; // type for new irrigation heads
const LS_HEAD_KINDS = ['spray', 'rotor', 'emitter', 'valve', 'controller', 'backflow'];
const LS_HEAD_LABEL = {
  spray: 'Spray head', rotor: 'Rotor head', emitter: 'Drip emitter',
  valve: 'Zone valve', controller: 'Controller', backflow: 'Backflow preventer',
};
const LS_HEAD_PRICE = { spray: 28, rotor: 52, emitter: 6, valve: 185, controller: 650, backflow: 850 }; // $/EA installed
const ESC_LINE_PRICE = { silt: 2.5, supersilt: 8, sock: 6, wattle: 4, treeprot: 3.5, berm: 3, curtain: 25 };
const TEXTURE_LABEL = { none: 'None', smooth: 'Smooth / skim', orange: 'Orange peel', knockdown: 'Knockdown', popcorn: 'Popcorn' };
const TEXTURE_PRICE = { smooth: 0.30, orange: 0.35, knockdown: 0.40, popcorn: 0.55 }; // $/SF texture (labor+material)
const INSUL_LABEL = { none: 'None', r11: 'R-11 batt', r13: 'R-13 batt', r15: 'R-15 batt', r19: 'R-19 batt', r21: 'R-21 batt', sound: 'Sound batt' };
const INSUL_PRICE = { r11: 0.55, r13: 0.60, r15: 0.70, r19: 0.80, r21: 0.90, sound: 0.75 }; // $/SF installed
let curDwOpening = 'door';
let curDwTrim = 'base';
// layer visibility (session view state) — declutter a busy sheet by category
const layers = { annot: true, measure: true, takeoff: true, labels: true, fills: true };
const ANNOT_KINDS = ['cloud', 'rect', 'ellipse', 'arrow', 'line', 'freehand', 'highlight', 'text', 'callout'];
const MEASURE_KINDS = ['mlength', 'marea', 'mcount'];
const markupLayer = kind => ANNOT_KINDS.includes(kind) ? 'annot' : MEASURE_KINDS.includes(kind) ? 'measure' : 'takeoff';
// Vertex editing. Fixed-box shapes, callouts, single-point & count markups get no
// per-vertex handles; everything else (line/arrow + every polyline/polygon) does.
const VERTEX_NONEDIT = new Set(['rect', 'ellipse', 'cloud', 'highlight', 'callout', 'text', 'espot', 'mcount', 'ritem', 'qcount', 'dopening', 'dheight', 'fopening', 'escitem', 'sstall', 'smark', 'sopening', 'dmitem', 'fngate', 'lsplant', 'lshead']);
// Insert/delete a vertex applies to the free polylines & polygons — line/arrow
// stay fixed 2-point shapes (their endpoints are still draggable).
const RESHAPE_NONEDIT = new Set([...VERTEX_NONEDIT, 'line', 'arrow']);
const layerVisible = m => layers[markupLayer(m.kind)];
let curSurface = 'existing';                 // which surface new contours/spots/pads belong to
let dirtSheetsCollapsed = false;             // dirt panel: Sheets section starts collapsed once the two-sheet setup is done
let dirtContoursCollapsed = false;           // dirt panel: the traced-contours list section
let dirtTakeoffCollapsed = false;            // dirt panel: the area/line/count takeoff-quantities list section
let dirtEarthworkCollapsed = false;          // dirt panel: the Earthwork (boundary + settings + calculate) section
// Per-type/color shape subgroups in the dirt panel collapse independently; keyed
// by a stable group key (see dirtGroupHeader). A Set of the COLLAPSED keys, so a
// group defaults to expanded until the user folds it.
const dirtGroupsCollapsed = new Set();
// Per-group MAP visibility: the eye icon on a header/subheader toggles whether
// that group's shapes draw on the plan. A Set of the HIDDEN vis keys (section or
// group), so everything is visible until the user clicks an eye off. Keyed the
// same way as shapeVisKeys / the panel groups.
const dirtHidden = new Set();
// Side-menu list scope: off = only the current page's shapes; on = every page's
// (the "Show markups from all pages" checkbox). This is a LIST filter only — the
// plan/canvas still draws the current page.
let dirtShowAllPages = false;
// Earthwork mode declutters the canvas: only dirt-trade markups draw, and only
// the focused surface's contours/pads. General redline + other-trade markups are
// hidden (they reappear when you leave dirt mode). Layer toggles apply on top.
const DIRT_KINDS = new Set(['contour', 'espot', 'epad', 'ebound', 'qarea', 'qline', 'qcount']);
function markupShown(m) {
  if (!layerVisible(m)) return false;
  if (state.trade !== 'dirt') return true;
  // A group hidden by its eye (section- or subgroup-level) doesn't draw.
  const vk = shapeVisKeys(m);
  if (vk && (dirtHidden.has(vk.section) || dirtHidden.has(vk.group))) return false;
  if (!DIRT_KINDS.has(m.kind)) return false;
  return !m.surface || m.surface === curSurface;
}
const lastElev = { existing: null, proposed: null };

const store = createStore('planroom');

const els = {
  cv: $('cv'), hud: $('hud'), dropHint: $('dropHint'), thumbRail: $('thumbRail'),
  pageInfo: $('pageInfo'), btnPrev: $('btnPrevPage'), btnNext: $('btnNextPage'),
  btnFit: $('btnFit'), projName: $('projName'), projects: $('projects'), projList: $('projList'),
  mkColor: $('mkColor'), mkWidth: $('mkWidth'), btnUndo: $('btnUndo'), btnRedo: $('btnRedo'),
  markupPanel: $('markupPanel'), mkList: $('mkList'), mkKindFilter: $('mkKindFilter'),
  mkThisSheet: $('mkThisSheet'), textOverlay: $('textOverlay'),
};

const modals = createModals({
  overlay: $('modal'), title: $('modalTitle'), body: $('modalBody'),
  ok: $('modalOk'), cancel: $('modalCancel'),
});

// Small N-way choice dialog reusing the modal overlay (createModals only does
// OK/Cancel). Resolves to the picked value, or null on Escape. choices:
// [{ label, value, primary?, danger? }].
function askChoice(title, message, choices) {
  return new Promise(resolve => {
    const actions = $('modalOk').parentElement;
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML =
      `<div class="hint" style="margin-bottom:12px;line-height:1.5">${message}</div>` +
      '<div style="display:flex;flex-direction:column;gap:8px">' +
      choices.map((c, i) => `<button class="btn ${c.primary ? 'primary' : ''}" data-choice="${i}"${c.danger ? ' style="border-color:#e0533f;color:#e0533f"' : ''}>${esc(c.label)}</button>`).join('') +
      '</div>';
    actions.style.display = 'none';
    $('modal').classList.remove('hidden');
    const done = val => {
      $('modalBody').removeEventListener('click', onClick);
      $('modal').removeEventListener('keydown', onKey);
      actions.style.display = ''; $('modal').classList.add('hidden');
      resolve(val);
    };
    const onClick = e => { const b = e.target.closest('[data-choice]'); if (b) done(choices[+b.dataset.choice].value); };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      else if (e.key === 'Enter') { e.preventDefault(); const pi = choices.findIndex(c => c.primary); done(choices[pi >= 0 ? pi : 0].value); }
    };
    $('modalBody').addEventListener('click', onClick);
    $('modal').addEventListener('keydown', onKey);
  });
}

const vp = createViewport({ canvas: els.cv });

// status toast: shows the message, then fades itself out (and click dismisses)
let hudTimer = null;
function setMsg(t) {
  clearTimeout(hudTimer);
  els.hud.textContent = t || '';
  els.hud.classList.remove('gone');
  if (t) hudTimer = setTimeout(() => els.hud.classList.add('gone'), 6000);
}
els.hud.addEventListener('click', () => { clearTimeout(hudTimer); els.hud.classList.add('gone'); });

/* ============================== Markup model ==============================
 * kind        pts                                other
 * cloud       [corner, corner]                   —
 * rect        [corner, corner]                   —
 * ellipse     [corner, corner]                   —
 * highlight   [corner, corner]                   — (translucent fill)
 * line/arrow  [a, b]                             — (arrow head at b)
 * freehand    polyline                           —
 * text        [anchor (top-left)]                text, fontSize
 * callout     [anchor (text top-left), target]   text, fontSize (leader → target)
 * Widths/sizes are document-space (base px) so markups print/zoom like ink.
 */

const MK_KINDS = ['cloud', 'rect', 'ellipse', 'arrow', 'line', 'freehand', 'highlight', 'text', 'callout', 'mlength', 'marea', 'mcount', 'plane', 'redge', 'ritem', 'contour', 'espot', 'epad', 'ebound', 'qarea', 'qline', 'qcount', 'dwall', 'dceiling', 'dopening', 'dtrim', 'dheight', 'froom', 'ftrans', 'fwall', 'fopening', 'fsheath', 'escline', 'escitem', 'escarea', 'sstripe', 'sstall', 'smark', 'swall', 'sopening', 'sgutter', 'sinsul', 'dmarea', 'dmline', 'dmitem', 'fnline', 'fngate', 'lsarea', 'lsplant', 'lsline', 'lshead'];
const MK_LABEL = {
  cloud: 'Cloud', rect: 'Rectangle', ellipse: 'Ellipse', arrow: 'Arrow', line: 'Line',
  freehand: 'Pen', highlight: 'Highlight', text: 'Text', callout: 'Callout',
  mlength: 'Length', marea: 'Area', mcount: 'Count',
  plane: 'Roof plane', redge: 'Roof edge', ritem: 'Roof item',
  contour: 'Contour', espot: 'Spot elev', epad: 'Pad', ebound: 'Earthwork boundary',
  qarea: 'Area takeoff', qline: 'Line takeoff', qcount: 'Count takeoff',
  dwall: 'Wall run', dceiling: 'Ceiling', dopening: 'Opening', dtrim: 'Trim', dheight: 'Height',
  froom: 'Floor room', ftrans: 'Transition', fwall: 'Framed wall', fopening: 'Framed opening', fsheath: 'Sheathing',
  escline: 'ESC control', escitem: 'ESC BMP', escarea: 'ESC area',
  sstripe: 'Stripe run', sstall: 'Parking stall', smark: 'Marking / sign',
  swall: 'Siding wall', sopening: 'Siding opening', sgutter: 'Gutter run', sinsul: 'Insulation',
  dmarea: 'Demo area', dmline: 'Demo removal', dmitem: 'Demo item',
  fnline: 'Fence run', fngate: 'Gate',
  lsarea: 'Landscape area', lsplant: 'Plant', lsline: 'Irrigation run', lshead: 'Irrigation head',
};
const MK_ICON = {
  cloud: '☁', rect: '▭', ellipse: '⬭', arrow: '↗', line: '╲',
  freehand: '✏', highlight: '🖍', text: 'T', callout: '🏷',
  mlength: '↔', marea: '⬠', mcount: '🔢',
  plane: '▰', redge: '╱', ritem: '⊕',
  contour: '⛰', espot: '◎', epad: '◫', ebound: '⬚',
  qarea: '▨', qline: '⌇', qcount: '⊙',
  dwall: '▬', dceiling: '⬜', dopening: '🚪', dtrim: '▁', dheight: '↕',
  froom: '▦', ftrans: '▂', fwall: '‖', fopening: '▯', fsheath: '▤',
  escline: '〰', escitem: '⊘', escarea: '▧',
  sstripe: '≡', sstall: '⊞', smark: '◆',
  swall: '▥', sopening: '⊡', sgutter: '⌐', sinsul: '▩',
  dmarea: '▣', dmline: '⌁', dmitem: '⊠',
  fnline: '⌗', fngate: '⊓',
  lsarea: '▢', lsplant: '❋', lsline: '≀', lshead: '⊛',
};
// Dirt-trade tool flyout groups (mirrors the sitework tool): each group shows the
// last-used tool as a one-click face + a ▾ caret revealing the rest.
const TOOL_GROUPS = {
  surface: ['wand', 'contour', 'espot', 'epad'],
  takeoff: ['autoarea', 'qarea', 'qline', 'qcount'],
};
const TOOL_FACE = {
  wand: '🪄 Auto-trace', contour: '⛰ Contour', espot: '◎ Spot', epad: '◫ Pad',
  autoarea: '▩ Auto-area', qarea: '▨ Area', qline: '⌇ Line', qcount: '⊙ Count',
};
const groupCurrent = { surface: 'contour', takeoff: 'qarea' };
const MEASURE_TOOLS = ['calibrate', 'mlength', 'marea', 'mcount'];
const CLICK_TOOLS = ['mlength', 'marea', 'mcount', 'plane', 'redge', 'ritem', 'contour', 'epad', 'ebound', 'qarea', 'qline', 'qcount', 'dwall', 'dceiling', 'dopening', 'dtrim', 'dheight', 'froom', 'ftrans', 'fwall', 'fopening', 'fsheath', 'escline', 'escitem', 'escarea', 'sstripe', 'sstall', 'smark', 'swall', 'sopening', 'sgutter', 'sinsul', 'dmarea', 'dmline', 'dmitem', 'fnline', 'fngate', 'lsarea', 'lsplant', 'lsline', 'lshead']; // click-built (vs drag; espot/align are special-cased)
const NEEDS_SCALE = ['mlength', 'marea', 'plane', 'redge', 'qarea', 'qline', 'dwall', 'dceiling', 'dtrim', 'froom', 'ftrans', 'fwall', 'fsheath', 'escline', 'escarea', 'sstripe', 'swall', 'sgutter', 'sinsul', 'dmarea', 'dmline', 'fnline', 'lsarea', 'lsline']; // produce ft / SF / squares

/* ---- earthwork (sitework pack) helpers ---- */
// stable hue per elevation so equal elevations match visually; existing lighter
function elevColor(elev, surface) {
  const h = ((elev * 47) % 360 + 360) % 360;
  return surface === 'existing' ? `hsl(${h}, 70%, 62%)` : `hsl(${h}, 85%, 52%)`;
}
const surfaceContours = surface => state.markups.filter(m => m.kind === 'contour' && m.surface === surface);

// inverse of the align transform (proposed→existing) as another {a,b,e,f}
function alignInverse(M) {
  const s2 = M.a * M.a + M.b * M.b || 1;
  return {
    a: M.a / s2, b: -M.b / s2,
    e: -(M.a * M.e + M.b * M.f) / s2,
    f: (M.b * M.e - M.a * M.f) / s2,
  };
}

/* two-sheet alignment state: click a landmark on the existing sheet, then its
   match on the proposed sheet. 1 pair = shift; 2 pairs = shift+rotation+scale. */
let alignDraft = null;   // { pts:[existing-page pts], qs:[proposed-page pts], prevAlign }
let ghostOn = false;     // overlay the other sheet through the align transform

function earthworkCounts() {
  return {
    existing: state.markups.filter(m => (m.kind === 'contour' || m.kind === 'espot' || m.kind === 'epad') && m.surface === 'existing').length,
    proposed: state.markups.filter(m => (m.kind === 'contour' || m.kind === 'espot' || m.kind === 'epad') && m.surface === 'proposed').length,
    boundary: state.markups.some(m => m.kind === 'ebound'),
  };
}

/* ---- roofing takeoff (the $60 takeoff layer) ---- */
const EDGE_TYPES = ['eave', 'rake', 'ridge', 'hip', 'valley', 'flashing'];
const EDGE_LABEL = { eave: 'Eave', rake: 'Rake', ridge: 'Ridge', hip: 'Hip', valley: 'Valley', flashing: 'Flashing' };
const ITEM_TYPES = ['boot', 'vent', 'skylight', 'chimney'];
const ITEM_LABEL = { boot: 'Pipe boot', vent: 'Vent', skylight: 'Skylight', chimney: 'Chimney' };

// entitlement gate — the main app exposes tc_addons; the takeoff layer needs it
function hasTakeoffLayer() {
  try {
    const a = JSON.parse(localStorage.getItem('tc_addons') || '{}');
    return !!(a.takeoff || a.status === 'exempt' || a.status === 'trial');
  } catch (_) { return false; }
}
// deep storm/utility takeoff (pipe schedule, structure depth, invert depth,
// netting) is its own paid add-on layered on the takeoff. Gates the deep fields.
function hasStormAddon() {
  try {
    const a = JSON.parse(localStorage.getItem('tc_addons') || '{}');
    return !!(a.storm || a.status === 'exempt' || a.status === 'trial');
  } catch (_) { return false; }
}
// Roof Measurement is its own paid add-on (the EagleView-style report mode),
// independent of the takeoff layer. Same reader shape as storm; gates the
// roof-measure mode entry + its report panel.
function hasRoofAddon() {
  try {
    const a = JSON.parse(localStorage.getItem('tc_addons') || '{}');
    return !!(a.roof || a.status === 'exempt' || a.status === 'trial');
  } catch (_) { return false; }
}
// Dev override: preview the roof-only "Door A" experience even when entitled to
// takeoff (exempt/trial read BOTH flags true, so Door A would normally hide).
// `?roofsolo=1` turns it on (persisted); `?roofsolo=0` clears it.
function roofSoloPreview() {
  try {
    const u = new URLSearchParams(location.search);
    if (u.has('roofsolo')) localStorage.setItem('tc_roof_solo', u.get('roofsolo') !== '0' ? '1' : '0');
    return localStorage.getItem('tc_roof_solo') === '1';
  } catch (_) { return false; }
}

// pitch-correction: sloped length / area factor for a given rise-per-12
function slopeFactor(pitch) { const p = (pitch || 0) / 12; return Math.sqrt(1 + p * p); }
function hipValleyFactor(pitch) { const p = (pitch || 0) / 12; return Math.sqrt(1 + p * p / 2); }
function edgeFactor(etype, pitch) {
  if (etype === 'rake') return slopeFactor(pitch);
  if (etype === 'hip' || etype === 'valley') return hipValleyFactor(pitch);
  return 1; // eave, ridge, flashing measured directly on the plan
}
const planeSquares = (m, ftPerPx) => polygonAreaFt2(m.pts, ftPerPx) * slopeFactor(m.pitch) / 100;
// Hip/valley/rake edges get longer with pitch, so the correction must use the
// pitch of THAT edge's roof, not one roof-wide value — otherwise a multi-pitch
// roof's edge LF is only right for the main pitch. Each edge carries its own
// `pitch` (captured at draw time); edges saved before that existed have no
// `pitch` and fall back to the global default, so old projects are unchanged.
const edgeFt = (m, ftPerPx) => polyLengthFt(m.pts, ftPerPx) * edgeFactor(m.etype, m.pitch != null ? m.pitch : state.roofPitch);

// Roofing bid lines: materials/labor derived from the live takeoff, with
// editable unit prices. Sensible defaults; every quantity traces to the roof.
const DEFAULT_ROOF_PRICES = {
  tearoff: 50, install: 125, shingles: 38, ridgecap: 4.5, underlayment: 45,
  icewater: 1.75, dripedge: 1.25, starter: 1.1,
  item_boot: 30, item_vent: 35, item_skylight: 350, item_chimney: 450,
  ew_cut: 4.5, ew_fill: 6, ew_haul: 12, // earthwork $/CY (editable like the rest)
};
const priceFor = (key, def = 0) => (state.roofPrices[key] != null ? state.roofPrices[key] : (DEFAULT_ROOF_PRICES[key] != null ? DEFAULT_ROOF_PRICES[key] : def));

function roofBidLines() {
  // Trade mode drives the bid: a selected trade shows its FULL line list
  // (zeros included — the menu of what the bid can price). With no trade
  // selected, the bid is the consolidated view: every trade with actual
  // quantities, zero rows dropped.
  const lines = [];
  const trade = state.trade || '';
  const roofingActive = trade === 'roofing' ||
    (!trade && state.markups.some(m => ['plane', 'redge', 'ritem'].includes(m.kind)));
  if (roofingActive) {
    const T = roofingTotals();
    const sq = T.squaresWaste;
    const ridgeHip = (T.edges.ridge || 0) + (T.edges.hip || 0);
    const eaveRake = (T.edges.eave || 0) + (T.edges.rake || 0);
    const iceWater = (T.edges.eave || 0) + (T.edges.valley || 0);
    lines.push(
      { key: 'tearoff', label: 'Tear-off & disposal', qty: sq, unit: 'sq', q: 1 },
      { key: 'install', label: 'Shingle install (labor)', qty: sq, unit: 'sq', q: 1 },
      { key: 'shingles', label: 'Shingles (3 bundles/sq)', qty: Math.ceil(sq * 3), unit: 'bdl', q: 0 },
      { key: 'ridgecap', label: 'Ridge / hip cap', qty: ridgeHip, unit: 'LF', q: 0 },
      { key: 'underlayment', label: 'Underlayment (4 sq/roll)', qty: Math.ceil(sq / 4), unit: 'roll', q: 0 },
      { key: 'icewater', label: 'Ice & water (eave + valley)', qty: iceWater, unit: 'LF', q: 0 },
      { key: 'dripedge', label: 'Drip edge (eave + rake)', qty: eaveRake, unit: 'LF', q: 0 },
      { key: 'starter', label: 'Starter strip (eave + rake)', qty: eaveRake, unit: 'LF', q: 0 },
      ...ITEM_TYPES.filter(k => T.items[k]).map(k => ({
        key: 'item_' + k, label: ITEM_LABEL[k] + ' flashing', qty: T.items[k], unit: 'EA', q: 0,
      })),
    );
  }
  // earthwork lines from the cut/fill result (same math as the dirt panel)
  const R = state.earthwork.result;
  if ((trade === 'dirt' || !trade) && R) {
    const shrink = (Number(state.earthwork.shrink) || 0) / 100;
    const swell = (Number(state.earthwork.swell) || 0) / 100;
    const fillBank = R.fillCY / Math.max(0.01, 1 - shrink);
    const net = R.cutCY - fillBank;
    lines.push({ key: 'ew_cut', label: 'Earthwork — excavation (cut, bank)', qty: R.cutCY, unit: 'CY', q: 0 });
    lines.push({ key: 'ew_fill', label: 'Earthwork — fill placed (compacted)', qty: R.fillCY, unit: 'CY', q: 0 });
    if (net > 0) lines.push({ key: 'ew_haul', label: 'Earthwork — export haul-off (loose)', qty: net * (1 + swell), unit: 'CY', q: 0 });
  }
  // quantity takeoffs (area/line/count/wall) belong to the sitework trade
  if (trade === 'dirt' || !trade) { lines.push(...areaBidLines()); lines.push(...lineBidLines()); lines.push(...countBidLines()); }
  if (trade === 'drywall' || !trade) lines.push(...drywallBidLines());
  if (trade === 'flooring' || !trade) lines.push(...flooringBidLines());
  if (trade === 'framing' || !trade) lines.push(...framingBidLines());
  if (trade === 'esc' || !trade) lines.push(...escBidLines());
  if (trade === 'striping' || !trade) lines.push(...stripingBidLines());
  if (trade === 'siding' || !trade) lines.push(...sidingBidLines());
  if (trade === 'demo' || !trade) lines.push(...demoBidLines());
  if (trade === 'fence' || !trade) lines.push(...fenceBidLines());
  if (trade === 'landscape' || !trade) lines.push(...landscapeBidLines());
  // consolidated view (no trade selected): only rows with real quantities
  const finalLines = trade ? lines.filter(l => Math.abs(l.qty) > 0.001) : lines.filter(l => l.qty > 0);
  for (const l of finalLines) { l.price = priceFor(l.key, l.defPrice || 0); l.ext = l.qty * l.price; }
  const subtotal = finalLines.reduce((a, l) => a + l.ext, 0);
  const op = subtotal * (Number(state.roofOP) || 0) / 100;
  return { lines: finalLines, subtotal, op, total: subtotal + op };
}

// aggregate roofing quantities across the whole set (live)
function roofingTotals() {
  const wasteMul = 1 + (Number(state.roofWaste) || 0) / 100;
  let squares = 0, planes = 0, scaleMissing = false;
  const edges = {}, items = {};
  for (const m of state.markups) {
    const s = state.scales[m.page] || 0;
    if (m.kind === 'plane') { planes++; if (s) squares += planeSquares(m, s); else scaleMissing = true; }
    else if (m.kind === 'redge') { if (s) edges[m.etype] = (edges[m.etype] || 0) + edgeFt(m, s); else scaleMissing = true; }
    else if (m.kind === 'ritem') items[m.itype] = (items[m.itype] || 0) + m.pts.length;
  }
  return { squares, squaresWaste: squares * wasteMul, planes, edges, items, scaleMissing };
}

/* ---- per-sheet scale + measured values (recomputed live, never stored) ---- */

const pageFtPerPx = (p = state.page) => state.scales[p] || 0;

/* ---- editable on-canvas scale bar (per sheet). The bar's geometry + real-world
   feet are the source of truth; state.scales[page] (ftPerPx) is kept in sync so
   every measurement keeps reading it unchanged. ---- */
function applyScaleBar(page) {
  const bar = state.scaleBars[page];
  if (!bar) return;
  const px = Math.hypot(bar.b.x - bar.a.x, bar.b.y - bar.a.y);
  if (bar.feet > 0 && px > 0.5) state.scales[page] = bar.feet / px;
}
function clearScale(page) {
  delete state.scaleBars[page];
  delete state.scales[page];
  scheduleSave(); markupsChanged();
  setMsg(`Scale cleared for sheet ${page} — recalibrate with 📏 (click two points).`);
}
function scaleBarHandle(bar, w) {
  const h = 9 / vp.view.zoom;
  if (Math.abs(w.x - bar.a.x) <= h && Math.abs(w.y - bar.a.y) <= h) return 'a';
  if (Math.abs(w.x - bar.b.x) <= h && Math.abs(w.y - bar.b.y) <= h) return 'b';
  return null;
}
const niceRound = n => { if (!(n > 0)) return 1; const p = Math.pow(10, Math.floor(Math.log10(n))); const f = n / p; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p; };
// Rebuild an editable bar for a sheet that has a scale but no bar (calibrated
// before bars existed) — a horizontal bar at view center, round-foot label, exact scale.
function synthScaleBar(page) {
  const fpp = state.scales[page];
  if (!fpp) return;
  const r = els.cv.parentElement.getBoundingClientRect();
  const cx = (r.width / 2 - vp.view.panX) / vp.view.zoom, cy = (r.height / 2 - vp.view.panY) / vp.view.zoom;
  const feet = niceRound((r.width * 0.4 / vp.view.zoom) * fpp);
  const lenPx = feet / fpp;
  state.scaleBars[page] = { a: { x: cx - lenPx / 2, y: cy }, b: { x: cx + lenPx / 2, y: cy }, feet };
}
// ── Edge/corner jump pads (ported from sitework) ──────────────────────────────
// Shown only when zoomed in past ~70% of fit, where drag-navigation gets tedious.
// The shared viewport already provides panByFraction + zoomedPastFit; this just
// toggles the pads' visibility each paint (the clicks are wired at the bottom).
function updateNavPads() {
  const nav = $('navPads');
  if (!nav) return;
  const base = state.doc ? pageBase.get(state.page) : null;
  const show = !!(base && base.width > 0 && vp.zoomedPastFit(base.width, base.height));
  nav.classList.toggle('hidden', !show);
  els.cv.parentElement.classList.toggle('nav-active', show);
}

// Show a calibration distance as entered — 207.9 stays 207.9, 208 stays 208 —
// instead of rounding a fractional value up to a whole number.
function scaleFeetStr(v) {
  const r = Math.round(v * 100) / 100;               // trim float noise, cap at 2 dp
  const d = Number.isInteger(r) ? 0 : (Math.round(r * 10) / 10 === r ? 1 : 2);
  return fmt(r, d);
}

// Show an elevation as entered — 197.85 stays 197.85, 812 stays 812 — instead of
// rounding a fractional value to a single decimal. Survey elevations run to
// hundredths; keep 3 dp of headroom and trim trailing zeros.
function elevStr(v) {
  const r = Math.round(v * 1000) / 1000;             // trim float noise, cap at 3 dp
  const d = Number.isInteger(r) ? 0
    : Math.round(r * 10) / 10 === r ? 1
    : Math.round(r * 100) / 100 === r ? 2 : 3;
  return fmt(r, d);
}

function drawScaleBar(ctx) {
  if (tool !== 'calibrate') return;
  const bar = state.scaleBars[state.page];
  if (!bar) return;
  const { a, b, feet } = bar, z = vp.view.zoom;
  ctx.save();
  ctx.strokeStyle = '#e0a03f'; ctx.lineWidth = 2.5 / z;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L, tk = 8 / z;
  for (const p of [a, b]) { ctx.beginPath(); ctx.moveTo(p.x - nx * tk, p.y - ny * tk); ctx.lineTo(p.x + nx * tk, p.y + ny * tk); ctx.stroke(); }
  const hh = 5 / z;
  ctx.fillStyle = '#fff'; ctx.lineWidth = 1.5 / z;
  for (const p of [a, b]) { ctx.fillRect(p.x - hh, p.y - hh, hh * 2, hh * 2); ctx.strokeRect(p.x - hh, p.y - hh, hh * 2, hh * 2); }
  const base = pageBase.get(state.page);
  const fs = Math.max(11, Math.min(28, (base ? base.width : 2800) / 120));
  ctx.font = `700 ${fs}px "Segoe UI", system-ui, sans-serif`;
  ctx.textBaseline = 'bottom'; ctx.textAlign = 'center';
  const txt = `${scaleFeetStr(feet)} ft`, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - 7 / z;
  ctx.lineWidth = fs / 4.5; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.strokeText(txt, mx, my);
  ctx.fillStyle = '#e0a03f'; ctx.fillText(txt, mx, my);
  ctx.restore();
}

function measureValue(m) {
  const s = state.scales[m.page] || 0;
  if (m.kind === 'mcount') return `${m.pts.length} × ${m.text || 'items'}`;
  if (m.kind === 'ritem') return `${m.pts.length} × ${ITEM_LABEL[m.itype] || 'item'}`;
  if (!s) return 'no scale — 📏 this sheet';
  if (m.kind === 'mlength') {
    const ft = polyLengthFt(m.pts, s);
    return fmt(ft, ft < 100 ? 1 : 0) + ' ft';
  }
  if (m.kind === 'marea') {
    const sf = polygonAreaFt2(m.pts, s);
    return fmt(sf, 0) + ' SF' + (sf > 21780 ? ` (${fmt(sf / 43560, 2)} ac)` : '');
  }
  if (m.kind === 'plane') return `${fmt(m.pitch || 0)}/12 · ${fmt(planeSquares(m, s), 1)} sq`;
  if (m.kind === 'redge') {
    const ft = edgeFt(m, s);
    return `${EDGE_LABEL[m.etype] || 'Edge'} · ${fmt(ft, ft < 100 ? 1 : 0)} ft`;
  }
  if (m.kind === 'contour' || m.kind === 'espot' || m.kind === 'epad') {
    return `${m.surface === 'existing' ? 'EG' : 'FG'} ${m.elev != null ? elevStr(m.elev) : '?'}`;
  }
  if (m.kind === 'ebound') return 'Limits of disturbance';
  if (m.kind === 'qarea') {
    const cfg = m.cfg || {};
    const r = computeAreaResult(qareaSf(m), cfg, qareaPerimFt(m));
    const q = cfg.mode === 'strip' ? `${fmt(r.stripCY, 1)} CY`
      : cfg.mode === 'area' ? `${fmt(r.areaSf)} SF`
      : `${fmt(r.quantity, 1)} ${r.unit}`;
    return `${cfg.deduct ? '– ' : ''}${cfg.label || 'Area'} · ${q}`;
  }
  if (m.kind === 'qline') {
    const cfg = m.cfg || {};
    const r = computeLineResult(qlineLenFt(m), cfg);
    const head = pipeScheduleLabel(cfg);
    return `${head} · ${fmt(r.lengthFt)} ft${r.trenchCY ? ` · ${fmt(r.trenchCY, 1)} CY` : ''}`;
  }
  if (m.kind === 'qcount') { const cfg = m.cfg || {}; const d = STORM_ON ? (parseFloat(cfg.depth) || 0) : 0; return `${m.pts.length} ${cfg.unit || 'EA'} · ${cfg.label || 'Item'}${d > 0 ? ` @ ${fmt(d, 1)} ft` : ''}`; }
  if (m.kind === 'dwall') return `${fmt(dwallLenFt(m))} ft · ${fmt(dwallSf(m))} SF (${m.sides || 2}s @ ${fmt(dwallHeight(m))}')`;
  if (m.kind === 'dceiling') { const ct = (m.cfg && m.cfg.ctype) || 'drywall'; return `${CEIL_LABEL[ct] || 'Drywall'} ceiling · ${fmt(dceilingSf(m))} SF`; }
  if (m.kind === 'dopening') { const c = m.cfg || {}; const n = m.pts.length; return `${n} ${OPENING_LABEL[c.otype] || 'Opening'}${n === 1 ? '' : 's'} (−${fmt(c.deductSF || 0)} SF ea)`; }
  if (m.kind === 'dtrim') { const c = m.cfg || {}; return `${TRIM_LABEL[c.ttype] || 'Trim'} · ${fmt(polyLengthFt(m.pts, state.scales[m.page] || 0))} ft`; }
  if (m.kind === 'dheight') return `${m.text || 'Height'} · ${fmt(polyLengthFt(m.pts, s), 1)} ft`;
  if (m.kind === 'froom') { const cfg = m.cfg || {}; return `${FLOOR_LABEL[cfg.ftype] || 'Floor'} · ${fmt(polygonAreaFt2(m.pts, s), 0)} SF`; }
  if (m.kind === 'ftrans') { const cfg = m.cfg || {}; return `${TRANS_LABEL[cfg.ttype] || 'Transition'} · ${fmt(polyLengthFt(m.pts, s), 0)} ft`; }
  if (m.kind === 'fwall') { const cfg = m.cfg || {}; return `${FRAM_SIZE_LABEL[cfg.size] || '2×4'} wall · ${fmt(polyLengthFt(m.pts, s), 0)} ft`; }
  if (m.kind === 'fopening') { const cfg = m.cfg || {}; const n = m.pts.length; return `${n} ${FOPEN_LABEL[cfg.otype] || 'Opening'}${n === 1 ? '' : 's'} (${fmt(cfg.width || 0, 1)}' RO)`; }
  if (m.kind === 'fsheath') { const cfg = m.cfg || {}; return `${SHEATH_LABEL[cfg.stype] || 'Sheathing'} · ${fmt(polygonAreaFt2(m.pts, s), 0)} SF`; }
  if (m.kind === 'escline') { const cfg = m.cfg || {}; return `${ESC_LINE_LABEL[cfg.ltype] || 'Silt fence'} · ${fmt(polyLengthFt(m.pts, s), 0)} ft`; }
  if (m.kind === 'escitem') { const cfg = m.cfg || {}; const n = m.pts.length; return `${n} × ${ESC_ITEM_LABEL[cfg.itype] || 'BMP'}`; }
  if (m.kind === 'escarea') { const cfg = m.cfg || {}; return `${ESC_AREA_LABEL[cfg.atype] || 'Area'} · ${fmt(polygonAreaFt2(m.pts, s), 0)} SF`; }
  if (m.kind === 'sstripe') { const cfg = m.cfg || {}; return `${STRP_LINE_LABEL[cfg.stype] || '4" line'} · ${fmt(polyLengthFt(m.pts, s), 0)} ft`; }
  if (m.kind === 'sstall') { const cfg = m.cfg || {}; const n = m.pts.length; return `${n} × ${STRP_STALL_LABEL[cfg.ttype] || 'Stall'}`; }
  if (m.kind === 'smark') { const cfg = m.cfg || {}; const n = m.pts.length; return `${n} × ${STRP_MARK_LABEL[cfg.mtype] || 'Marking'}`; }
  if (m.kind === 'swall') { const cfg = m.cfg || {}; return `${SID_MAT_LABEL[cfg.mat] || 'Siding'} · ${fmt(polygonAreaFt2(m.pts, s), 0)} SF`; }
  if (m.kind === 'sopening') { const cfg = m.cfg || {}; const n = m.pts.length; return `${n} ${SID_OPEN_LABEL[cfg.otype] || 'Opening'}${n === 1 ? '' : 's'} (−${fmt(cfg.deductSF || 0, 0)} SF ea)`; }
  if (m.kind === 'sgutter') { const cfg = m.cfg || {}; return `${SID_GUT_LABEL[cfg.gtype] || 'Gutter'} · ${fmt(polyLengthFt(m.pts, s), 0)} ft`; }
  if (m.kind === 'sinsul') { const cfg = m.cfg || {}; return `${SID_INS_LABEL[cfg.itype] || 'Insulation'} · ${fmt(polygonAreaFt2(m.pts, s), 0)} SF`; }
  if (m.kind === 'dmarea') { const cfg = m.cfg || {}; return `${DM_AREA_LABEL[cfg.dtype] || 'Demo'} · ${fmt(polygonAreaFt2(m.pts, s), 0)} SF`; }
  if (m.kind === 'dmline') { const cfg = m.cfg || {}; return `${DM_LINE_LABEL[cfg.ltype] || 'Removal'} · ${fmt(polyLengthFt(m.pts, s), 0)} ft`; }
  if (m.kind === 'dmitem') { const cfg = m.cfg || {}; const n = m.pts.length; return `${n} × ${DM_ITEM_LABEL[cfg.itype] || 'Item'}`; }
  if (m.kind === 'fnline') { const cfg = m.cfg || {}; const t = cfg.ftype || 'chain6'; const lf = polyLengthFt(m.pts, s); return `${FN_LINE_LABEL[t] || 'Fence'} · ${fmt(lf, 0)} ft · ${fencePostsFor(lf, t)} posts`; }
  if (m.kind === 'fngate') { const cfg = m.cfg || {}; const n = m.pts.length; return `${n} × ${FN_GATE_LABEL[cfg.gtype] || 'Gate'}`; }
  if (m.kind === 'lsarea') { const cfg = m.cfg || {}; return `${LS_AREA_LABEL[cfg.atype] || 'Landscape'} · ${fmt(polygonAreaFt2(m.pts, s), 0)} SF`; }
  if (m.kind === 'lsplant') { const cfg = m.cfg || {}; const n = m.pts.length; return `${n} × ${LS_PLANT_LABEL[cfg.ptype] || 'Plant'}`; }
  if (m.kind === 'lsline') { const cfg = m.cfg || {}; return `${LS_LINE_LABEL[cfg.ltype] || 'Irrigation'} · ${fmt(polyLengthFt(m.pts, s), 0)} ft`; }
  if (m.kind === 'lshead') { const cfg = m.cfg || {}; const n = m.pts.length; return `${n} × ${LS_HEAD_LABEL[cfg.htype] || 'Head'}`; }
  return '';
}
const LINE_W = { S: 2, M: 4, L: 8 };
const FONT_S = { S: 12, M: 18, L: 28 };

// last-used color per tool (highlighter yellow; roofing kinds distinct)
const toolColors = { highlight: '#ffe066', plane: '#3fbf6f', redge: '#4da3ff', ritem: '#e0a03f' };
const DEFAULT_COLOR = '#e05555';

let tool = 'pan';
let selectedId = null;
let drag = null;      // {mode:'pan'|'draw'|'move'|'handle', ...}
let undoCapture = null;
let draft = null;     // click-built measure in progress {kind, pts, prev, past, future}
let draftDrag = null; // dragging an already-placed draft vertex {i, ptr, prev, moved}
let calibPts = null;  // [firstPoint] while calibrating
let hoverW = null;    // cursor world pos while drafting (rubber band)
let previewing = false; // true while drawMarkup renders the in-progress draft
let editOp = 'move';  // active edit-points operation while a reshapeable shape is selected: move|add|remove|cut|join
let editMode = 'points'; // how the Select tool edits a reshapeable shape: points | box | circle (marquee)
let editRegionOp = 'delpoints'; // what a Box/Circle marquee does: delpoints | delarea
let _editbarOn = null; // cache so refreshEditbar only writes the DOM when it changes
let joinPick = null;  // {id, vi} — the first endpoint picked in Join mode, between the two clicks
// Join op "extend" session: after clicking a loose end you stay connected to it —
// { id, atFront }. A plain click then lays a point (extending that end) or welds to
// another loose end; a drag pans. Enter/Esc/double-click finish.
let extend = null;
// MOVE op tap-to-join: tap a loose end to connect (moveEnd = { id, vi }), then TAP
// another end (no movement, quick) to weld them. Any movement, or a held press,
// falls through to a normal vertex Move. A tap = released within TAP_MS, unmoved.
let moveEnd = null;
const TAP_MS = 300;
let circleCenter = null; // world point after the first click of a Circle marquee (awaiting the radius click)

const centroid = pts => ({
  x: pts.reduce((a, p) => a + p.x, 0) / pts.length,
  y: pts.reduce((a, p) => a + p.y, 0) / pts.length,
});

const curColor = () => els.mkColor.value;
const curWidth = () => LINE_W[els.mkWidth.value] || LINE_W.M;
const curFont = () => FONT_S[els.mkWidth.value] || FONT_S.M;
const selMarkup = () => state.markups.find(m => m.id === selectedId) || null;

// "Edit mode" = the Select tool with a reshapeable markup selected. Drives the
// visibility of the Edit-points toolbar. refreshEditbar() is called from the
// render loop and only touches the DOM when the state flips.
function editModeActive() { return tool === 'select' && !!selectedId && canReshape(selMarkup()); }
function refreshEditbar() {
  const on = editModeActive();
  if (on === _editbarOn) return;
  _editbarOn = on;
  if (on) { setEditMode('points'); setEditOp('move'); } // (re)entering edit mode always starts at Points / Move
  document.body.classList.toggle('pr-editing', on);
}
function setEditOp(op) {
  editOp = op;
  joinPick = null; extend = null; moveEnd = null; // any pending Join pick / extend / connect is abandoned when the op changes
  const sel = document.getElementById('prEditOp');
  if (sel && sel.value !== op) sel.value = op;
}
function setEditMode(mode) {
  editMode = mode;
  circleCenter = null; joinPick = null; extend = null; moveEnd = null; hoverW = null;
  document.body.classList.toggle('pr-region', mode !== 'points');
  const sel = document.getElementById('prEditMode');
  if (sel && sel.value !== mode) sel.value = mode;
  // a marquee mode wants a crosshair; point editing keeps the arrow
  els.cv.classList.toggle('crosshair', tool === 'select' && mode !== 'points');
  els.cv.style.cursor = baseCursor();
  vp.requestDraw();
}

/* ============================== Undo / redo ============================== */

const undoStack = [], redoStack = [];
const snapshot = () => JSON.stringify(state.markups);

function updateUndoButtons() {
  const dU = draft && draft.past && draft.past.length;
  const dR = draft && draft.future && draft.future.length;
  els.btnUndo.disabled = !(undoStack.length || dU);
  els.btnRedo.disabled = !(redoStack.length || dR);
}
function pushUndo(prevJson) {
  undoStack.push(prevJson);
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}
function restoreMarkups(json) {
  state.markups = JSON.parse(json);
  if (selectedId && !selMarkup()) selectedId = null;
  markupsChanged();
}
// While a click-built draft is open, undo/redo step through its OWN point history
// (each add / move / remove) instead of the committed-markup stack — so you can't
// accidentally unwind a finished markup mid-draw, and every point edit is reversible.
function draftRecord(prevPtsJson) {
  if (!draft) return;
  draft.past = draft.past || [];
  draft.past.push(prevPtsJson);
  if (draft.past.length > 400) draft.past.shift();
  draft.future = [];
  updateUndoButtons();
}
function draftStepBack() {
  draft.future = draft.future || [];
  draft.future.push(JSON.stringify(draft.pts));
  draft.pts = JSON.parse(draft.past.pop());
  updateUndoButtons(); vp.requestDraw();
}
function draftStepFwd() {
  draft.past = draft.past || [];
  draft.past.push(JSON.stringify(draft.pts));
  draft.pts = JSON.parse(draft.future.pop());
  updateUndoButtons(); vp.requestDraw();
}
function undo() {
  if (draft) { if (draft.past && draft.past.length) draftStepBack(); return; }
  if (undoStack.length) { redoStack.push(snapshot()); restoreMarkups(undoStack.pop()); updateUndoButtons(); }
}
function redo() {
  if (draft) { if (draft.future && draft.future.length) draftStepFwd(); return; }
  if (redoStack.length) { undoStack.push(snapshot()); restoreMarkups(redoStack.pop()); updateUndoButtons(); }
}
els.btnUndo.addEventListener('click', undo);
els.btnRedo.addEventListener('click', redo);

// Bumped on every markup MEMBERSHIP change (add / remove / undo / page-reassign) — all of
// which funnel through markupsChanged. Lets paint() cache the current page's markups instead
// of filtering the whole array every frame. (In-place edits — dragging a point — mutate the
// same objects the cached list already references, so they still draw live.)
let markupsRev = 0;
let _pageMkCache = { page: -1, rev: -1, ref: null, len: -1, list: [] };
function currentPageMarkups() {
  const c = _pageMkCache;
  if (c.page === state.page && c.rev === markupsRev && c.ref === state.markups && c.len === state.markups.length) return c.list;
  const list = state.markups.filter(m => m.page === state.page);
  _pageMkCache = { page: state.page, rev: markupsRev, ref: state.markups, len: state.markups.length, list };
  return list;
}

// every mutation funnels through here: redraw, refresh lists, autosave
function markupsChanged() {
  markupsRev++;
  renderMarkupList();
  if (typeof renderRoofPanel === 'function') renderRoofPanel();
  if (typeof renderRoofReport === 'function') renderRoofReport();
  if (typeof renderDirtPanel === 'function') renderDirtPanel();
  if (typeof renderDrywallPanel === 'function') renderDrywallPanel();
  if (typeof renderFlooringPanel === 'function') renderFlooringPanel();
  if (typeof renderFramingPanel === 'function') renderFramingPanel();
  if (typeof renderEscPanel === 'function') renderEscPanel();
  if (typeof renderStripingPanel === 'function') renderStripingPanel();
  if (typeof renderSidingPanel === 'function') renderSidingPanel();
  if (typeof renderDemoPanel === 'function') renderDemoPanel();
  if (typeof renderFencePanel === 'function') renderFencePanel();
  if (typeof renderLandscapePanel === 'function') renderLandscapePanel();
  scheduleSave();
  vp.requestDraw();
}

/* ============================== Markup rendering ============================== */

const normRect = (a, b) => ({
  x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y),
  x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y),
});

// Revision cloud: semicircle scallops bulging outward along the rect edges.
function cloudPath(ctx, r) {
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  const rad = Math.max(5, Math.min(22, Math.min(w, h) / 6 || 8));
  const edge = (ax, ay, bx, by, bulge) => {
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / (rad * 2)));
    const ux = (bx - ax) / n, uy = (by - ay) / n;
    for (let i = 0; i < n; i++) {
      const cx = ax + ux * (i + 0.5), cy = ay + uy * (i + 0.5);
      const a0 = Math.atan2(ay + uy * i - cy, ax + ux * i - cx);
      ctx.arc(cx, cy, Math.hypot(ux, uy) / 2, a0, a0 + Math.PI * bulge, bulge < 0);
    }
  };
  ctx.beginPath();
  ctx.moveTo(r.x0, r.y0);
  edge(r.x0, r.y0, r.x1, r.y0, 1);
  edge(r.x1, r.y0, r.x1, r.y1, 1);
  edge(r.x1, r.y1, r.x0, r.y1, 1);
  edge(r.x0, r.y1, r.x0, r.y0, 1);
  ctx.closePath();
}

function arrowHead(ctx, from, to, size) {
  const a = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - size * Math.cos(a - 0.45), to.y - size * Math.sin(a - 0.45));
  ctx.lineTo(to.x - size * Math.cos(a + 0.45), to.y - size * Math.sin(a + 0.45));
  ctx.closePath();
  ctx.fill();
}

function textLines(m) { return String(m.text || '').split('\n'); }

// Measured text-box geometry {x0,y0,x1,y1,pad,lineH} for text/callout kinds.
function textBox(ctx, m) {
  const fs = m.fontSize || 18;
  ctx.font = `${fs}px "Segoe UI", system-ui, sans-serif`;
  const lines = textLines(m);
  const wMax = Math.max(1, ...lines.map(l => ctx.measureText(l).width));
  const pad = fs * 0.4, lineH = fs * 1.25;
  const a = m.pts[0];
  return { x0: a.x - pad, y0: a.y - pad, x1: a.x + wMax + pad, y1: a.y + lines.length * lineH + pad, pad, lineH, fs };
}

function drawTextBlock(ctx, m, withBox) {
  const tb = textBox(ctx, m);
  if (withBox) {
    ctx.fillStyle = 'rgba(255,255,255,.88)';
    ctx.strokeStyle = m.color;
    ctx.lineWidth = Math.max(1, (m.width || 4) / 2);
    ctx.beginPath();
    ctx.roundRect(tb.x0, tb.y0, tb.x1 - tb.x0, tb.y1 - tb.y0, tb.pad);
    ctx.fill(); ctx.stroke();
  }
  ctx.fillStyle = withBox ? '#1c2126' : m.color;
  ctx.font = `${tb.fs}px "Segoe UI", system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  textLines(m).forEach((l, i) => ctx.fillText(l, m.pts[0].x, m.pts[0].y + i * tb.lineH));
  return tb;
}

function drawMarkup(ctx, m) {
  ctx.save();
  ctx.strokeStyle = m.color;
  ctx.fillStyle = m.color;
  ctx.lineWidth = m.width || 4;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const [p0, p1] = m.pts;
  switch (m.kind) {
    case 'rect': {
      const r = normRect(p0, p1);
      ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      break;
    }
    case 'ellipse': {
      const r = normRect(p0, p1);
      ctx.beginPath();
      ctx.ellipse((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, (r.x1 - r.x0) / 2, (r.y1 - r.y0) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'cloud':
      cloudPath(ctx, normRect(p0, p1));
      ctx.stroke();
      break;
    case 'highlight': {
      const r = normRect(p0, p1);
      ctx.globalAlpha = 0.3;
      ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      break;
    }
    case 'line':
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      break;
    case 'arrow':
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      arrowHead(ctx, p0, p1, (m.width || 4) * 3.5);
      break;
    case 'freehand':
      ctx.beginPath();
      m.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.stroke();
      break;
    case 'text':
      drawTextBlock(ctx, m, false);
      break;
    case 'callout': {
      const tb = drawTextBlock(ctx, m, true);
      // leader from the box edge nearest the target
      const cx = Math.max(tb.x0, Math.min(tb.x1, p1.x));
      const cy = Math.max(tb.y0, Math.min(tb.y1, p1.y));
      ctx.strokeStyle = m.color; ctx.fillStyle = m.color;
      ctx.lineWidth = Math.max(1.5, (m.width || 4) / 2);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      arrowHead(ctx, { x: cx, y: cy }, p1, (m.width || 4) * 2.5 + 4);
      break;
    }
    case 'mlength': {
      ctx.beginPath();
      m.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.stroke();
      const mid = m.pts[Math.floor((m.pts.length - 1) / 2)];
      labelAt(ctx, m, mid.x, mid.y - (m.width || 4) * 2.5);
      break;
    }
    case 'froom':
    case 'fsheath':
    case 'escarea':
    case 'swall':
    case 'sinsul':
    case 'dmarea':
    case 'lsarea':
    case 'marea': {
      if (m.pts.length >= 2) {
        ctx.beginPath();
        m.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
        ctx.closePath();
        // A deducting area is a void — outline only, no colored fill (matches the
        // deduct convention used on earthwork/dirt areas).
        if (layers.fills && !(m.cfg && m.cfg.deduct)) { ctx.globalAlpha = 0.12; ctx.fill(); ctx.globalAlpha = 1; }
        ctx.stroke();
      }
      if (m.pts.length >= 3) { const c = centroid(m.pts); labelAt(ctx, m, c.x, c.y); }
      break;
    }
    case 'mcount': case 'ritem': case 'qcount': case 'dopening': case 'fopening': case 'escitem': case 'sstall': case 'smark': case 'sopening': case 'dmitem': case 'fngate': case 'lsplant': case 'lshead': {
      const r = (m.width || 4) * 1.5 + 3;
      for (const p of m.pts) { ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); }
      const c = centroid(m.pts);
      if (m.pts.length) labelAt(ctx, m, c.x, c.y - r * 2.4);
      break;
    }
    case 'fwall':
    case 'ftrans':
    case 'escline':
    case 'sstripe':
    case 'sgutter':
    case 'dmline':
    case 'fnline':
    case 'lsline':
    case 'dtrim': {
      ctx.beginPath();
      m.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.stroke();
      const mid = m.pts[Math.floor((m.pts.length - 1) / 2)];
      labelAt(ctx, m, mid.x, mid.y - (m.width || 4) * 2.5);
      break;
    }
    case 'dheight': {
      ctx.beginPath();
      m.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.stroke();
      const a = m.pts[0], b = m.pts[m.pts.length - 1];
      if (a && b) {
        const cap = (m.width || 4) * 2.2;
        for (const p of [a, b]) { ctx.beginPath(); ctx.moveTo(p.x - cap, p.y); ctx.lineTo(p.x + cap, p.y); ctx.stroke(); }
        labelAt(ctx, m, (a.x + b.x) / 2 + cap + 3, (a.y + b.y) / 2);
      }
      break;
    }
    case 'plane': {
      if (m.pts.length >= 2) {
        ctx.beginPath();
        m.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
        ctx.closePath();
        if (layers.fills) { ctx.globalAlpha = 0.14; ctx.fill(); ctx.globalAlpha = 1; }
        ctx.stroke();
      }
      if (m.pts.length >= 3) { const c = centroid(m.pts); labelAt(ctx, m, c.x, c.y); }
      break;
    }
    case 'redge': {
      ctx.beginPath();
      m.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.stroke();
      const mid = m.pts[Math.floor((m.pts.length - 1) / 2)];
      labelAt(ctx, m, mid.x, mid.y - (m.width || 4) * 2.5);
      break;
    }
    case 'contour': {
      const col = elevColor(m.elev || 0, m.surface);
      // existing dashed, proposed solid — kept, but thin & screen-constant like the boundary
      dirtOutline(ctx, m, col, { dash: m.surface === 'existing' ? [11, 6] : null });
      const e = m.pts[m.pts.length - 1];
      if (e) elevLabel(ctx, m, e.x, e.y, col);
      break;
    }
    case 'espot': {
      const col = elevColor(m.elev || 0, m.surface);
      const p = m.pts[0]; if (!p) break;
      const z = vp.view.zoom, r = 7 / z; // screen-constant bullseye, crisp at any zoom
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2 / z;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.8 / z, 0, Math.PI * 2); ctx.fill();
      elevLabel(ctx, m, p.x + r * 1.8, p.y, col);
      break;
    }
    case 'epad': {
      const col = elevColor(m.elev || 0, m.surface);
      dirtOutline(ctx, m, col, { closed: true, dash: [12, 7], fillAlpha: 0.10 });
      if (m.pts.length >= 3) { const c = centroid(m.pts); elevLabel(ctx, m, c.x, c.y, col); }
      break;
    }
    case 'ebound': {
      dirtOutline(ctx, m, '#e0a03f', { closed: true, dash: [12, 7], fillAlpha: 0.06 });
      break;
    }
    case 'qarea': {
      const col = areaColorHex(m.cfg || {});
      // A deduct is a void: outline only, no fill of its own. An additive area
      // fills with its same-type deducts punched out as real holes, so the deduct
      // region shows the plan through — not a colored fill (its own or the
      // additive's beneath it).
      if (m.cfg && m.cfg.deduct) {
        dirtOutline(ctx, m, col, { closed: true, dash: [12, 7], fillAlpha: 0 });
      } else {
        fillAreaWithDeducts(ctx, m, col);
        dirtOutline(ctx, m, col, { closed: true, dash: [12, 7], fillAlpha: 0 });
      }
      if (m.pts.length >= 3) { const c = centroid(m.pts); labelAt(ctx, m, c.x, c.y, col); }
      break;
    }
    case 'qline': {
      const col = lineColorHex(m.cfg || {});
      dirtOutline(ctx, m, col, {});
      const mid = m.pts[Math.floor((m.pts.length - 1) / 2)];
      if (mid) labelAt(ctx, m, mid.x, mid.y - 8 / vp.view.zoom, col);
      break;
    }
    case 'dwall': {
      if ((m.sides || 2) === 2) ctx.lineWidth = (m.width || 4) * 1.6; // partitions (both faces) read heavier
      ctx.beginPath();
      m.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.stroke();
      const mid = m.pts[Math.floor((m.pts.length - 1) / 2)];
      labelAt(ctx, m, mid.x, mid.y - (m.width || 4) * 2.8);
      break;
    }
    case 'dceiling': {
      if (m.pts.length >= 2) {
        ctx.beginPath(); m.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
        if (layers.fills) { ctx.globalAlpha = 0.14; ctx.fill(); ctx.globalAlpha = 1; }
        ctx.stroke();
      }
      if (m.pts.length >= 3) { const c = centroid(m.pts); labelAt(ctx, m, c.x, c.y); }
      break;
    }
  }
  ctx.restore();
}

// The "elegant" earthwork/takeoff outline: thin and SCREEN-CONSTANT (width & dash
// divided by zoom) so it stays crisp when you zoom in for fine work instead of
// ballooning with the pen width — the boundary (ebound) look, shared by the rest
// of the dirt family.
function dirtOutline(ctx, m, col, opts) {
  if (!m.pts || m.pts.length < 2) return;
  const o = opts || {};
  const z = vp.view.zoom;
  ctx.strokeStyle = col; ctx.fillStyle = col;
  ctx.lineWidth = (o.screenWidth || 2) / z;
  ctx.setLineDash(o.dash ? [o.dash[0] / z, o.dash[1] / z] : []);
  ctx.beginPath();
  m.pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  if (o.closed) ctx.closePath();
  if (o.fillAlpha && o.closed && m.pts.length >= 3 && layers.fills) { ctx.globalAlpha = o.fillAlpha; ctx.fill(); ctx.globalAlpha = 1; }
  ctx.stroke();
  ctx.setLineDash([]);
}

// Fill an additive area takeoff, with any same-type deduct areas punched out as
// real holes (so the plan shows through the cutout, not a colored fill). Deducts
// subtract from their own label (matching the bid math), so the visual hole
// tracks the same grouping. Clip to the additive first so a deduct that pokes
// outside it never paints fill where there's no area.
function fillAreaWithDeducts(ctx, m, col) {
  if (!layers.fills || !m.pts || m.pts.length < 3) return;
  const label = (m.cfg && m.cfg.label) || '';
  const holes = state.markups.filter(x =>
    x !== m && x.kind === 'qarea' && x.page === m.page &&
    x.cfg && x.cfg.deduct && (x.cfg.label || '') === label &&
    x.pts && x.pts.length >= 3);
  const trace = pts => { pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); };
  ctx.save();
  ctx.beginPath(); trace(m.pts); ctx.clip();          // paint only inside the additive
  ctx.beginPath(); trace(m.pts);                      // outer ring …
  for (const h of holes) trace(h.pts);                // … minus each deduct ring
  ctx.fillStyle = col; ctx.globalAlpha = 0.12;
  ctx.fill('evenodd');                                // even-odd → additive with holes
  ctx.globalAlpha = 1;
  ctx.restore();
}

// elevation label (white-haloed, colored by elevation) for earthwork markups
function elevLabel(ctx, m, x, y, col) {
  if (!layers.labels) return;
  // While placing (draft preview) or editing (this markup is selected), suppress
  // the "?" placeholder — you're mid-edit and haven't typed the elevation yet.
  // Once it's a settled, unselected markup the "?" returns as a "needs elevation" flag.
  const editing = previewing || (m.id && m.id === selectedId);
  const txt = m.elev != null ? elevStr(m.elev) : (editing ? '' : '?');
  if (!txt) return;
  const base = pageBase.get(m.page);
  const fs = Math.max(11, Math.min(28, (base ? base.width : 2800) / 120));
  ctx.save();
  ctx.font = `700 ${fs}px "Segoe UI", system-ui, sans-serif`;
  ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.lineWidth = fs / 4.5; ctx.strokeStyle = 'rgba(255,255,255,.92)';
  ctx.strokeText(txt, x, y);
  ctx.fillStyle = col; ctx.fillText(txt, x, y);
  ctx.restore();
}

// Measured-value label: white-haloed bold text, sized to the sheet.
function labelAt(ctx, m, x, y, color) {
  if (!layers.labels) return;
  const base = pageBase.get(m.page);
  const fs = Math.max(11, Math.min(30, (base ? base.width : 2800) / 110));
  ctx.save();
  ctx.font = `700 ${fs}px "Segoe UI", system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.lineWidth = fs / 4.5;
  ctx.strokeStyle = 'rgba(255,255,255,.92)';
  ctx.strokeText(measureValue(m), x, y);
  ctx.fillStyle = color || m.color;
  ctx.fillText(measureValue(m), x, y);
  ctx.restore();
}

function drawCross(ctx, x, y, r, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 / vp.view.zoom;
  ctx.beginPath();
  ctx.moveTo(x - r, y); ctx.lineTo(x + r, y);
  ctx.moveTo(x, y - r); ctx.lineTo(x, y + r);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// alignment landmarks (and the predicted-spot hint on the proposed sheet)
function drawAlignDraft(ctx) {
  if (!alignDraft) return;
  const E = state.earthwork;
  const r = 12 / vp.view.zoom;
  if (state.page === E.existingPage) {
    for (const p of alignDraft.pts) drawCross(ctx, p.x, p.y, r, '#e0a03f');
  } else if (state.page === E.proposedPage) {
    for (const q of alignDraft.qs) drawCross(ctx, q.x, q.y, r, '#e0a03f');
    // where the current alignment predicts the pending landmark lands
    if (alignDraft.pts.length > alignDraft.qs.length && alignIsSet()) {
      const p = alignDraft.pts[alignDraft.pts.length - 1];
      const inv = alignInverse(E.align);
      const g = { x: inv.a * p.x - inv.b * p.y + inv.e, y: inv.b * p.x + inv.a * p.y + inv.f };
      drawCross(ctx, g.x, g.y, r * 1.3, '#3fbf6f');
    }
  }
}

// In-progress measure/calibration overlay (rubber-banded to the cursor).
function drawDraft(ctx) {
  if (calibPts && calibPts.length) {
    const a = calibPts[0], b = hoverW || a;
    ctx.save();
    ctx.strokeStyle = '#e0a03f';
    ctx.fillStyle = '#e0a03f';
    ctx.lineWidth = 2 / vp.view.zoom;
    ctx.setLineDash([8 / vp.view.zoom, 5 / vp.view.zoom]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.setLineDash([]);
    for (const p of [a, b]) { ctx.beginPath(); ctx.arc(p.x, p.y, 5 / vp.view.zoom, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }
  if (draft && draft.pts.length) {
    // no rubber-band tail while dragging an existing vertex — show the real shape
    const pts = (hoverW && !draftDrag && !POINT_KINDS.includes(draft.kind)) ? [...draft.pts, hoverW] : draft.pts;
    const previewExtra =
      draft.kind === 'plane' ? { pitch: state.roofPitch } :
      draft.kind === 'redge' ? { etype: ($('edgeType') || {}).value || 'eave' } :
      draft.kind === 'ritem' ? { itype: ($('itemType') || {}).value || 'boot' } : {};
    previewing = true;
    try {
      drawMarkup(ctx, {
        kind: draft.kind, pts, page: state.page,
        color: curColor(), width: curWidth(),
        text: POINT_KINDS.includes(draft.kind) ? '…' : undefined,
        ...previewExtra,
      });
    } finally { previewing = false; }
    drawDraftHandles(ctx);
  }
}

// Draggable vertex handles for a line/polygon draft, so previously-placed points
// read as grabbable (point-count kinds skip this — each click is its own marker).
function drawDraftHandles(ctx) {
  if (!draft || !draft.pts.length || POINT_KINDS.includes(draft.kind)) return;
  const z = vp.view.zoom;
  ctx.save();
  draft.pts.forEach((p, i) => {
    const active = draftDrag && draftDrag.i === i;
    ctx.beginPath(); ctx.arc(p.x, p.y, 6 / z, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fill();
    ctx.lineWidth = 1.6 / z; ctx.strokeStyle = active ? '#e0a03f' : '#4da3ff'; ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y, 1.8 / z, 0, Math.PI * 2);
    ctx.fillStyle = active ? '#e0a03f' : '#4da3ff'; ctx.fill();
  });
  ctx.restore();
}

// Nearest draft vertex to w within a forgiving, zoom-aware grab radius (or -1).
function draftGrabIndex(w) {
  if (!draft || !draft.pts.length) return -1;
  const tol = Math.max(9 / vp.view.zoom, 5);
  let best = -1, bd = tol;
  draft.pts.forEach((p, i) => { const d = Math.hypot(p.x - w.x, p.y - w.y); if (d <= bd) { bd = d; best = i; } });
  return best;
}

// Bounding box in world px (for selection, centering, hit slop).
function markupBBox(ctx, m) {
  if (m.kind === 'text' || m.kind === 'callout') {
    const tb = textBox(ctx, m);
    let { x0, y0, x1, y1 } = tb;
    if (m.kind === 'callout') {
      x0 = Math.min(x0, m.pts[1].x); y0 = Math.min(y0, m.pts[1].y);
      x1 = Math.max(x1, m.pts[1].x); y1 = Math.max(y1, m.pts[1].y);
    }
    return { x0, y0, x1, y1 };
  }
  const xs = m.pts.map(p => p.x), ys = m.pts.map(p => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/* ---- selection handles ---- */

function handlePoints(ctx, m) {
  if (['rect', 'ellipse', 'cloud', 'highlight'].includes(m.kind)) {
    const r = normRect(m.pts[0], m.pts[1]);
    return [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
  }
  if (m.kind === 'callout') return [m.pts[1]]; // move the leader target
  if (VERTEX_NONEDIT.has(m.kind)) return [];
  if (hasHoles(m)) return [m.outer, ...m.holes].flat(); // handles on the real outer + hole rings, not the keyhole
  return m.pts; // per-vertex handles: line/arrow endpoints + every polyline/polygon point
}

function drawSelection(ctx, m) {
  const bb = markupBBox(ctx, m);
  const s = 4 / vp.view.zoom;
  ctx.save();
  ctx.strokeStyle = '#4da3ff';
  ctx.lineWidth = 1.5 / vp.view.zoom;
  ctx.setLineDash([6 / vp.view.zoom, 4 / vp.view.zoom]);
  ctx.strokeRect(bb.x0 - s, bb.y0 - s, (bb.x1 - bb.x0) + s * 2, (bb.y1 - bb.y0) + s * 2);
  ctx.setLineDash([]);
  // Ring handles (like sitework) — a white halo, an accent ring, and a small
  // center dot marking the EXACT vertex, so you can place points precisely
  // against a line instead of a filled square covering the spot.
  const z = vp.view.zoom;
  for (const p of handlePoints(ctx, m)) {
    ctx.beginPath(); ctx.arc(p.x, p.y, 6 / z, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fill();
    ctx.lineWidth = 1.6 / z; ctx.strokeStyle = '#4da3ff'; ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y, 1.7 / z, 0, Math.PI * 2);
    ctx.fillStyle = '#4da3ff'; ctx.fill();
  }
  ctx.restore();
}

// Green ring on the first endpoint picked in Join mode (world coords; drawn
// inside the page transform, before ctx.restore()).
function drawJoinPick(ctx) {
  const m = state.markups.find(x => x.id === joinPick.id);
  if (!m || m.page !== state.page || !m.pts || !m.pts[joinPick.vi]) return;
  const p = m.pts[joinPick.vi], z = vp.view.zoom;
  ctx.save();
  ctx.beginPath(); ctx.arc(p.x, p.y, 8 / z, 0, Math.PI * 2);
  ctx.lineWidth = 2.4 / z; ctx.strokeStyle = '#22c55e'; ctx.stroke();
  ctx.restore();
}

// Extend session: a ring on the connected end + a dashed rubber-band to the cursor,
// so it's clear you're laying points off that end.
function drawExtend(ctx) {
  const m = state.markups.find(x => x.id === extend.id);
  if (!m || m.page !== state.page || !m.pts || !m.pts.length) return;
  const end = extend.atFront ? m.pts[0] : m.pts[m.pts.length - 1], z = vp.view.zoom;
  ctx.save();
  if (hoverW) {
    ctx.beginPath(); ctx.moveTo(end.x, end.y); ctx.lineTo(hoverW.x, hoverW.y);
    ctx.lineWidth = 1.6 / z; ctx.strokeStyle = '#4da3ff'; ctx.setLineDash([6 / z, 4 / z]); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.beginPath(); ctx.arc(end.x, end.y, 7 / z, 0, Math.PI * 2);
  ctx.lineWidth = 2.4 / z; ctx.strokeStyle = '#4da3ff'; ctx.stroke();
  ctx.restore();
}

// Green ring on the endpoint the MOVE-op tap-to-join is connected to.
function drawMoveEnd(ctx) {
  const m = state.markups.find(x => x.id === moveEnd.id);
  if (!m || m.page !== state.page || !m.pts || !m.pts[moveEnd.vi]) return;
  const p = m.pts[moveEnd.vi], z = vp.view.zoom;
  ctx.save();
  ctx.beginPath(); ctx.arc(p.x, p.y, 8 / z, 0, Math.PI * 2);
  ctx.lineWidth = 2.4 / z; ctx.strokeStyle = '#22c55e'; ctx.stroke();
  ctx.restore();
}

/* ---- hit testing (world coords; tolerances shrink with zoom) ---- */

function hitHandle(ctx, m, w) {
  const h = 7 / vp.view.zoom;
  const hps = handlePoints(ctx, m);
  for (let i = 0; i < hps.length; i++) {
    if (Math.abs(w.x - hps[i].x) <= h && Math.abs(w.y - hps[i].y) <= h) return i;
  }
  return -1;
}

// Selection + double-click both resolve through here, so EVERY kind in MK_KINDS
// needs a case: there's no default, and an unlisted kind silently can't be
// clicked — not selectable, not movable, not deletable, and its double-click
// config never fires. The flooring/framing packs each shipped without one, so
// their documented "double-click to change material / size" did nothing.
function hitMarkup(ctx, w) {
  const tol = Math.max(6 / vp.view.zoom, 3);
  for (let i = state.markups.length - 1; i >= 0; i--) {
    const m = state.markups[i];
    if (m.page !== state.page || !markupShown(m)) continue; // hidden layers/surfaces/kinds aren't clickable
    const t = tol + (m.width || 4) / 2;
    const [p0, p1] = m.pts;
    switch (m.kind) {
      case 'rect': case 'cloud': {
        const r = normRect(p0, p1);
        const nearX = w.x > r.x0 - t && w.x < r.x1 + t, nearY = w.y > r.y0 - t && w.y < r.y1 + t;
        const onEdge = nearX && nearY &&
          (Math.abs(w.x - r.x0) < t || Math.abs(w.x - r.x1) < t ||
           Math.abs(w.y - r.y0) < t || Math.abs(w.y - r.y1) < t);
        if (onEdge) return m;
        break;
      }
      case 'ellipse': {
        const r = normRect(p0, p1);
        const rx = (r.x1 - r.x0) / 2 || 1, ry = (r.y1 - r.y0) / 2 || 1;
        const dx = (w.x - (r.x0 + rx)) / rx, dy = (w.y - (r.y0 + ry)) / ry;
        const d = Math.abs(Math.hypot(dx, dy) - 1);
        if (d * Math.min(rx, ry) < t) return m;
        break;
      }
      case 'highlight': {
        const r = normRect(p0, p1);
        if (w.x > r.x0 && w.x < r.x1 && w.y > r.y0 && w.y < r.y1) return m;
        break;
      }
      case 'line': case 'arrow':
        if (pointSegDist(w.x, w.y, p0.x, p0.y, p1.x, p1.y) < t) return m;
        break;
      case 'freehand': case 'mlength': case 'redge': case 'contour': case 'qline': case 'dwall': case 'dtrim':
      case 'fwall': case 'ftrans': case 'dheight': case 'escline': case 'sstripe': case 'sgutter': case 'dmline': case 'fnline': case 'lsline':
        if (distToPolyline(w.x, w.y, m.pts) < t) return m;
        break;
      case 'marea': case 'plane': case 'epad': case 'qarea': case 'dceiling':
      case 'froom': case 'fsheath': case 'escarea': case 'swall': case 'sinsul': case 'dmarea': case 'lsarea':
        if (pointInPolygon(w.x, w.y, m.pts) ||
            distToPolyline(w.x, w.y, [...m.pts, m.pts[0]]) < t) return m;
        break;
      case 'ebound':
        if (distToPolyline(w.x, w.y, [...m.pts, m.pts[0]]) < t) return m; // edge only (fill is faint)
        break;
      case 'mcount': case 'ritem': case 'qcount': case 'dopening': case 'fopening': case 'escitem': case 'sstall': case 'smark': case 'sopening': case 'dmitem': case 'fngate': case 'lsplant': case 'lshead':
        if (m.pts.some(p => dist(w.x, w.y, p.x, p.y) < (m.width || 4) * 1.5 + 3 + t)) return m;
        break;
      case 'espot':
        if (dist(w.x, w.y, m.pts[0].x, m.pts[0].y) < (m.width || 4) * 1.4 + 4 + t) return m;
        break;
      case 'text': case 'callout': {
        const tb = textBox(ctx, m);
        if (w.x > tb.x0 - t && w.x < tb.x1 + t && w.y > tb.y0 - t && w.y < tb.y1 + t) return m;
        if (m.kind === 'callout' &&
            pointSegDist(w.x, w.y, (tb.x0 + tb.x1) / 2, (tb.y0 + tb.y1) / 2, p1.x, p1.y) < t) return m;
        break;
      }
    }
  }
  return null;
}

/* ============================== Page rendering ============================== */

// Rendered page canvases (with the scale they were rendered at), kept under a
// pixel budget; base sizes are tiny and kept for all pages.
const pageCanvas = new Map();  // pageNum -> { canvas, scale }
const pageBase = new Map();    // pageNum -> { width, height } at scale 1
const inflight = new Map();    // pageNum -> Promise
const PAGE_PIXEL_BUDGET = 60e6;   // ~240 MB of RGBA across cached pages
const PAGE_MAX_PIXELS = 22e6;     // per-page cap when sharpening zoomed views

async function baseSize(p) {
  if (!pageBase.has(p)) pageBase.set(p, await state.doc.baseSize(p));
  return pageBase.get(p);
}

// Density-aware base target: enough pixels for THIS screen at fit, not a
// fixed width — a blurry viewer is a broken viewer.
function dprTargetWidth() {
  const r = els.cv.parentElement.getBoundingClientRect();
  return Math.min(4200, Math.max(2600, r.width * devicePixelRatio * 1.25));
}
const scaleCapFor = base => Math.max(1, Math.min(4, Math.sqrt(PAGE_MAX_PIXELS / (base.width * base.height))));
const defaultScaleFor = base =>
  Math.min(defaultRenderScale(base.width, { targetWidth: dprTargetWidth(), maxScale: 3 }), scaleCapFor(base));

function ensurePage(p, wantScale) {
  if (!state.doc) return Promise.resolve();
  const cur = pageCanvas.get(p);
  if (cur && (!wantScale || cur.scale >= wantScale * 0.99)) return Promise.resolve();
  if (inflight.has(p)) return inflight.get(p);
  const job = (async () => {
    const base = await baseSize(p);
    const scale = wantScale ? Math.min(wantScale, scaleCapFor(base)) : defaultScaleFor(base);
    const have = pageCanvas.get(p);
    if (have && have.scale >= scale * 0.99) return;
    const canvas = await state.doc.renderPage(p, scale);
    pageCanvas.delete(p);                    // re-insert = most recently used
    pageCanvas.set(p, { canvas, scale });
    evictPages();
    vp.requestDraw();
  })().finally(() => inflight.delete(p));
  inflight.set(p, job);
  return job;
}

function evictPages() {
  let total = 0;
  for (const { canvas } of pageCanvas.values()) total += canvas.width * canvas.height;
  for (const k of [...pageCanvas.keys()]) {
    if (total <= PAGE_PIXEL_BUDGET || pageCanvas.size <= 1) break;
    if (k === state.page) continue;
    const e = pageCanvas.get(k);
    total -= e.canvas.width * e.canvas.height;
    pageCanvas.delete(k);
  }
}

// Progressive sharpening: once zooming settles, re-render the current page at
// the resolution the view actually needs (bounded by the per-page pixel cap).
let sharpenTimer = null;
function maybeSharpen(entry, base) {
  const needed = Math.min(vp.view.zoom * devicePixelRatio, scaleCapFor(base));
  if (needed > entry.scale * 1.25) {
    clearTimeout(sharpenTimer);
    const p = state.page;
    sharpenTimer = setTimeout(() => { if (state.page === p) ensurePage(p, needed); }, 200);
  }
}

function paint(ctx) {
  vp.beginPaint(ctx);
  const entry = pageCanvas.get(state.page);
  const base = pageBase.get(state.page);
  // world units = base-scale px, so markups are resolution-independent
  if (entry && base) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(entry.canvas, 0, 0, base.width, base.height);
    maybeSharpen(entry, base);
  } else if (state.doc) ensurePage(state.page);
  // ghost: the OTHER earthwork sheet (image + its contours) through the align
  // transform, so the fit can be eyeballed
  const EW = state.earthwork;
  if (ghostOn && state.doc && EW.existingPage && EW.proposedPage && EW.existingPage !== EW.proposedPage &&
      (state.page === EW.existingPage || state.page === EW.proposedPage)) {
    const onExisting = state.page === EW.existingPage;
    const other = onExisting ? EW.proposedPage : EW.existingPage;
    const M = onExisting ? EW.align : alignInverse(EW.align);
    const oEntry = pageCanvas.get(other), oBase = pageBase.get(other);
    if (oEntry && oBase) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.transform(M.a, M.b, -M.b, M.a, M.e, M.f);
      ctx.drawImage(oEntry.canvas, 0, 0, oBase.width, oBase.height);
      for (const m of state.markups)
        if (m.page === other && ['contour', 'espot', 'epad'].includes(m.kind)) drawMarkup(ctx, m);
      ctx.restore();
    } else if (state.doc) ensurePage(other);
  }
  if (heatGrid && state.page === heatGrid.page && layers.takeoff) drawHeat(ctx);
  // Only the current page's markups (cached — see currentPageMarkups); markupShown stays in
  // the loop because layer toggles change it without a markup mutation.
  for (const m of currentPageMarkups()) if (markupShown(m)) drawMarkup(ctx, m);
  // The disturbance boundary applies to BOTH surfaces — when it lives on the other
  // earthwork sheet, project it onto this one through the alignment so it shows on
  // existing AND proposed (always, independent of the Ghost toggle).
  if (state.doc && EW.existingPage && EW.proposedPage && EW.existingPage !== EW.proposedPage &&
      (state.page === EW.existingPage || state.page === EW.proposedPage)) {
    const otherPg = state.page === EW.existingPage ? EW.proposedPage : EW.existingPage;
    const bound = state.markups.find(m => m.kind === 'ebound' && m.page === otherPg);
    if (bound && markupShown(bound)) {
      const M = state.page === EW.existingPage ? EW.align : alignInverse(EW.align);
      ctx.save();
      ctx.transform(M.a, M.b, -M.b, M.a, M.e, M.f);
      drawMarkup(ctx, bound);
      ctx.restore();
    }
  }
  if (drag && drag.mode === 'draw' && drag.markup) drawMarkup(ctx, drag.markup);
  drawDraft(ctx);
  drawScaleBar(ctx);
  drawAlignDraft(ctx);
  const sel = selMarkup();
  if (sel && sel.page === state.page) drawSelection(ctx, sel);
  if (joinPick) drawJoinPick(ctx);
  if (extend) drawExtend(ctx);
  if (moveEnd) drawMoveEnd(ctx);
  if ((drag && drag.mode === 'marquee-box') || circleCenter) drawMarquee(ctx);
  ctx.restore();
  refreshEditbar();  // show/hide the Edit-points toolbar to match the selection
  updateNavPads(); // DOM overlay, not canvas — safe after restore; runs each paint
}

/* ============================== Pages & thumbnails ============================== */

function updatePageUI() {
  const n = state.doc ? state.doc.numPages : 0;
  els.pageInfo.textContent = n ? `${state.page} / ${n}` : '– / –';
  els.btnPrev.disabled = !n || state.page <= 1;
  els.btnNext.disabled = !n || state.page >= n;
  els.btnFit.disabled = !n;
  els.thumbRail.querySelectorAll('.thumb').forEach(t =>
    t.classList.toggle('current', parseInt(t.dataset.page, 10) === state.page));
}

async function setPage(p, { fit = false } = {}) {
  if (!state.doc) return;
  state.page = Math.max(1, Math.min(state.doc.numPages, p));
  syncSurfaceToPage();
  // The dirt panel's shape lists are scoped to the current page, so they have to
  // re-render on every page change — including the saved-page restore during load
  // (self-guards to a no-op when the panel is hidden).
  renderDirtPanel();
  updatePageUI();
  updateJumpStartVisibility(); // show the button only on pages with a readable text layer
  await ensurePage(state.page);
  if (fit) { const b = await baseSize(state.page); vp.fitTo(b.width, b.height); }
  vp.requestDraw();
  scheduleSave();
}
// Landing on a designated sheet syncs the Existing/Proposed toggle (and the
// surface visibility filter) to it, so navigating by any means keeps them in
// step. Same-sheet jobs keep the toggle's manual choice.
function syncSurfaceToPage() {
  if (state.trade !== 'dirt') return;
  const E = state.earthwork;
  if (E.existingPage && E.proposedPage && E.existingPage !== E.proposedPage) {
    const s = state.page === E.existingPage ? 'existing' : state.page === E.proposedPage ? 'proposed' : null;
    if (s && s !== curSurface) curSurface = s;
  }
  renderSurfaceToggle(); // keep the toggle's gray/white/align state current on every page change
}

// Lazy thumbnail strip: placeholders now, rendered when scrolled into view.
const THUMB_W = 128;
let thumbObserver = null;

function buildThumbs() {
  els.thumbRail.innerHTML = '';
  if (thumbObserver) thumbObserver.disconnect();
  if (!state.doc) return;
  thumbObserver = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      thumbObserver.unobserve(en.target);
      renderThumb(en.target).catch(() => {});
    }
  }, { root: els.thumbRail, rootMargin: '200px' });
  for (let p = 1; p <= state.doc.numPages; p++) {
    const b = document.createElement('button');
    b.className = 'thumb';
    b.dataset.page = p;
    b.title = `Sheet ${p}`;
    b.innerHTML = `<div class="thumb-ph"></div><span class="thumb-num">${p}</span>`;
    b.addEventListener('click', () => setPage(p));
    els.thumbRail.appendChild(b);
    thumbObserver.observe(b);
  }
  updatePageUI();
}

async function renderThumb(btn) {
  const p = parseInt(btn.dataset.page, 10);
  const base = await baseSize(p);
  // render at display density ×1.5 supersample — CSS scales it down sharp
  // (at 1:1 CSS px, dense notes sheets collapse into black smears)
  const canvas = await state.doc.renderPage(p, (THUMB_W * devicePixelRatio * 1.5) / base.width);
  btn.querySelector('.thumb-ph').replaceWith(canvas);
}

/* ============================== Document opening ============================== */

async function openFromBytes(buf, name, type, { persist = true } = {}) {
  setMsg(`Loading ${name}…`);
  // pdf.js detaches the buffer it opens, so we hand it a copy. Only make the SECOND copy
  // (kept for local storage) when we're actually going to persist — the reopen/finalize
  // paths pass persist:false and never used it, wasting a full-file allocation on big sets.
  const keep = persist ? buf.slice(0) : null;
  try {
    state.doc = await openDoc(new Uint8Array(buf), { type });
  } catch (err) {
    console.error(err);
    setMsg(`Could not open ${name}: ${err.message}`);
    return false;
  }
  if (persist) {
    try {
      const key = await hashBytes(keep);
      await store.filesPut(key, { name, type: type || null, bytes: keep });
      state.docKey = key;
    } catch (err) {
      // It opened and works this session, but couldn't be written to local
      // storage — so it won't survive a reload. Show the persistent NOT SAVED
      // banner (separate from the HUD) instead of pretending it saved; let the
      // doc render so it's at least usable now.
      console.error('openFromBytes: could not store plan', err);
      flashSaveError();
    }
  }
  state.docName = name;
  state.docType = type || null;
  pageCanvas.clear(); pageBase.clear(); inflight.clear(); pageHasText.clear();
  els.dropHint.classList.add('hidden');
  document.body.classList.add('has-doc');
  buildThumbs();
  await setPage(1, { fit: true });
  const n = state.doc.numPages;
  setMsg(`Loaded ${name}${n > 1 ? ` (${n} sheets)` : ''}. Drag to pan · wheel to zoom.`);
  return true;
}

/* Combined-document model: a project's plan set is ONE PDF that we build by
   copying the sheets you pick out of each source file (images become pages).
   "Add plans" appends — existing sheets keep their page numbers, so markups
   and earthwork page refs stay valid. pdf-lib (global PDFLib) does the merge;
   pdf.js renders the picker thumbnails. */

async function currentCombinedBytes() {
  if (!state.docKey) return null;
  try { const f = await store.filesGet(state.docKey); return f && f.bytes ? f.bytes : null; } catch (_) { return null; }
}

// swap the project's document to freshly-built combined bytes and reopen it
async function finalizeCombined(combined, name) {
  const bytes = await combined.save(); // Uint8Array
  const oldKey = state.docKey;
  // Store the merged PDF FIRST and confirm it landed. If this fails (browser
  // storage full is the usual cause), do NOT repoint the project at a blob that
  // isn't there and do NOT delete the old one — that exact combination is how
  // adding a second PDF used to silently wipe the whole project.
  let key = null;
  try {
    key = await hashBytes(bytes);
    await store.filesPut(key, { name, type: 'application/pdf', bytes });
  } catch (err) {
    console.error('finalizeCombined: could not store merged PDF', err);
    saveError('Could not save the added pages — your browser’s storage may be full. Nothing was changed; free up space (or add fewer sheets) and try again.');
    return false; // project untouched: old docKey, old blob, and existing markups all intact
  }
  // openFromBytes copies internally (pdf.js detaches its copy, not `bytes`), so
  // the just-stored bytes stay intact
  const ok = await openFromBytes(bytes, name, 'application/pdf', { persist: false });
  if (!ok) { state.docKey = oldKey; return false; }
  state.docKey = key;
  state.docName = name;
  scheduleSave(true);
  if (!$('projects').classList.contains('hidden')) renderProjCurrent(); // reflect the new sheet count
  // Only now that the new blob is safely stored, drop the previous one if
  // nothing else references it.
  if (oldKey && oldKey !== key) {
    try { const all = await store.projAll(); if (!all.some(p => p.docKey === oldKey && p.id !== state.projectId)) await store.filesDelete(oldKey); } catch (_) {}
  }
  return true;
}

// image → one page sized to the image; JPG/PNG embed directly, else via canvas→PNG
async function embedImagePage(combined, bytes, mime) {
  let img;
  if (/jpe?g/i.test(mime)) img = await combined.embedJpg(bytes);
  else if (/png/i.test(mime)) img = await combined.embedPng(bytes);
  else {
    const png = await imageBytesToPng(bytes, mime);
    img = await combined.embedPng(png);
  }
  const page = combined.addPage([img.width, img.height]);
  page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
}

// decode any browser-supported image and re-encode as PNG bytes (webp/gif/etc.)
function imageBytesToPng(bytes, mime) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'image/png' }));
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas');
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0);
      URL.revokeObjectURL(url);
      c.toBlob(b => b ? b.arrayBuffer().then(ab => resolve(new Uint8Array(ab))) : reject(new Error('encode failed')), 'image/png');
    };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not read image')); };
    im.src = url;
  });
}

// import one file into the current project (page picker for multi-page PDFs)
async function importOneFile(file) {
  const { PDFDocument } = PDFLib;
  const buf = new Uint8Array(await file.arrayBuffer());
  const isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
  try {
    const existing = await currentCombinedBytes();
    const combined = existing ? await PDFDocument.load(existing, { ignoreEncryption: true }) : await PDFDocument.create();
    const baseName = state.docName || file.name;

    if (!isPdf) {
      setMsg(`Adding ${file.name}…`);
      await embedImagePage(combined, buf, file.type);
      return finalizeCombined(combined, existing ? baseName : file.name);
    }

    // PDF: pick which sheets to bring in
    const src = await openDoc(new Uint8Array(buf), { type: 'application/pdf' });
    const indices = await showPagePicker(src, file.name); // 0-based, or null to cancel
    if (!indices || !indices.length) { setMsg('Nothing added.'); return false; }
    setMsg(`Adding ${indices.length} sheet${indices.length === 1 ? '' : 's'}…`);
    const srcDoc = await PDFDocument.load(buf, { ignoreEncryption: true });
    const copied = await combined.copyPages(srcDoc, indices);
    for (const pg of copied) combined.addPage(pg);
    return finalizeCombined(combined, existing ? baseName : file.name);
  } catch (err) {
    console.error(err);
    setMsg(`Could not add ${file.name}: ${err.message}`);
    return false;
  }
}

async function importFiles(files) {
  for (const f of files) await importOneFile(f); // sequential — each PDF pops its own picker
}

$('filePlans').addEventListener('change', e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) importFiles(files);
});
$('canvasWrap').addEventListener('dragover', e => e.preventDefault());
$('canvasWrap').addEventListener('drop', e => {
  e.preventDefault();
  const files = [...e.dataTransfer.files];
  if (files.length) importFiles(files);
});

/* ---- page picker ---- */
let pagePickResolve = null;
async function showPagePicker(pdfDoc, name) {
  $('pagePickTitle').textContent = `Choose sheets — ${name}`;
  const grid = $('pagePickGrid');
  grid.innerHTML = '';
  const n = pdfDoc.numPages;
  const cells = [];
  const obs = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      obs.unobserve(en.target);
      const p = +en.target.dataset.page;
      const cell = en.target;
      pdfDoc.baseSize(p)
        .then(b => pdfDoc.renderPage(p, Math.min(1, (300 * (window.devicePixelRatio || 1)) / b.width)))
        .then(cv => { const ph = cell.querySelector('.pp-thumb'); if (ph) ph.replaceWith(cv); })
        .catch(() => {});
    }
  }, { root: grid, rootMargin: '250px' });
  for (let p = 1; p <= n; p++) {
    const cell = document.createElement('label');
    cell.className = 'pp-cell on';
    cell.dataset.page = p;
    cell.innerHTML = `<input type="checkbox" class="pp-check" checked><div class="pp-thumb">sheet ${p}…</div><span class="pp-num">${p}</span>`;
    const chk = cell.querySelector('.pp-check');
    chk.addEventListener('change', () => { cell.classList.toggle('on', chk.checked); updatePagePickCount(); });
    grid.appendChild(cell);
    cells.push(cell);
    obs.observe(cell);
  }
  updatePagePickCount();
  $('pagePick').classList.remove('hidden');
  return new Promise(resolve => {
    pagePickResolve = picked => { obs.disconnect(); $('pagePick').classList.add('hidden'); pagePickResolve = null; resolve(picked); };
  });
}
function updatePagePickCount() {
  const cells = [...$('pagePickGrid').children];
  const on = cells.filter(c => c.querySelector('.pp-check').checked).length;
  $('pagePickCount').textContent = `${on} of ${cells.length} sheet${cells.length === 1 ? '' : 's'} selected`;
  $('pagePickOk').disabled = on === 0;
}
function setAllPagePicks(v) {
  for (const c of $('pagePickGrid').children) { c.querySelector('.pp-check').checked = v; c.classList.toggle('on', v); }
  updatePagePickCount();
}
$('pagePickAll').addEventListener('click', () => setAllPagePicks(true));
$('pagePickNone').addEventListener('click', () => setAllPagePicks(false));
$('pagePickCancel').addEventListener('click', () => { if (pagePickResolve) pagePickResolve(null); });
$('pagePick').addEventListener('click', e => { if (e.target === $('pagePick') && pagePickResolve) pagePickResolve(null); });
$('pagePickOk').addEventListener('click', () => {
  if (!pagePickResolve) return;
  const idx = [...$('pagePickGrid').children]
    .filter(c => c.querySelector('.pp-check').checked)
    .map(c => +c.dataset.page - 1); // pdf-lib copyPages wants 0-based
  pagePickResolve(idx);
});

// triggered from the Projects modal ("Open / add plans")
function pickPlans() { $('filePlans').click(); }

/* ---- manage sheets: reorder / remove within the combined document ----
 * Rebuilds the combined PDF in the new order (pdf-lib) and remaps every
 * page-number reference — markups, per-sheet scales, and earthwork sheet
 * assignments — so nothing lands on the wrong sheet. Removing a sheet drops
 * its markups. */
let sheetPlan = null; // [{ page, removed }] in display order
let sheetMgrObs = null;
const sheetThumb = new Map(); // page -> rendered <canvas>, reused across reorders (per open)
function renderSheetMgr() {
  const list = $('sheetMgrList');
  list.innerHTML = '';
  if (sheetMgrObs) sheetMgrObs.disconnect();
  // Count markups per page ONCE, not once per row (was O(markups × pages) on every rebuild).
  const counts = {};
  for (const m of state.markups) counts[m.page] = (counts[m.page] || 0) + 1;
  // Render a sheet's thumbnail only when its row scrolls into view (like the page picker),
  // and cache it — a reorder/remove click rebuilds the list but REUSES the cached canvases
  // instead of re-rendering all N sheets through pdf.js every click (the 40-page slowdown).
  sheetMgrObs = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      sheetMgrObs.unobserve(en.target);
      const p = +en.target.dataset.page;
      if (sheetThumb.has(p)) continue;
      const th = en.target.querySelector('.sheet-thumb');
      state.doc.baseSize(p).then(b => state.doc.renderPage(p, Math.min(1, 128 / b.width))).then(cv => {
        sheetThumb.set(p, cv);
        if (th && th.isConnected) { th.innerHTML = ''; th.appendChild(cv); }
      }).catch(() => {});
    }
  }, { root: list, rootMargin: '250px' });
  sheetPlan.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'proj-row' + (s.removed ? ' sheet-removed' : '');
    row.dataset.page = s.page;
    const n = counts[s.page] || 0;
    row.innerHTML =
      '<div class="sheet-thumb"></div>' +
      `<div class="grow"><div class="name">Sheet ${s.page}</div><div class="meta">${n} markup${n === 1 ? '' : 's'}${s.removed ? ' · will be removed' : ''}</div></div>` +
      `<button class="btn tiny" data-act="up"${i === 0 ? ' disabled' : ''}>▲</button>` +
      `<button class="btn tiny" data-act="down"${i === sheetPlan.length - 1 ? ' disabled' : ''}>▼</button>` +
      `<button class="btn tiny${s.removed ? '' : ' danger'}" data-act="del">${s.removed ? 'Keep' : '✕'}</button>`;
    row.querySelector('[data-act="up"]').addEventListener('click', () => { if (i > 0) { [sheetPlan[i - 1], sheetPlan[i]] = [sheetPlan[i], sheetPlan[i - 1]]; renderSheetMgr(); } });
    row.querySelector('[data-act="down"]').addEventListener('click', () => { if (i < sheetPlan.length - 1) { [sheetPlan[i + 1], sheetPlan[i]] = [sheetPlan[i], sheetPlan[i + 1]]; renderSheetMgr(); } });
    row.querySelector('[data-act="del"]').addEventListener('click', () => { s.removed = !s.removed; renderSheetMgr(); });
    list.appendChild(row);
    const cached = sheetThumb.get(s.page);
    if (cached) row.querySelector('.sheet-thumb').appendChild(cached); // reuse — no re-render
    else sheetMgrObs.observe(row);
  });
}
function openSheetMgr() {
  if (!state.doc || state.doc.numPages < 1) return;
  sheetThumb.clear(); // fresh thumbnails for the current doc
  sheetPlan = [];
  for (let p = 1; p <= state.doc.numPages; p++) sheetPlan.push({ page: p, removed: false });
  renderSheetMgr();
  $('sheetMgr').classList.remove('hidden');
}
async function applySheetPlan(order) {
  const oldBytes = await currentCombinedBytes();
  if (!oldBytes) { setMsg('Could not read the current set.'); return; }
  setMsg('Rebuilding the set…');
  try {
    const { PDFDocument } = PDFLib;
    const srcDoc = await PDFDocument.load(oldBytes, { ignoreEncryption: true });
    const out = await PDFDocument.create();
    const copied = await out.copyPages(srcDoc, order.map(p => p - 1));
    for (const pg of copied) out.addPage(pg);
    const map = {}; // old 1-based page -> new 1-based page
    order.forEach((oldP, i) => { map[oldP] = i + 1; });
    state.markups = state.markups.filter(m => map[m.page] != null); // drop removed sheets
    for (const m of state.markups) m.page = map[m.page];
    const ns = {}, nbars = {};
    for (const [p, v] of Object.entries(state.scales)) if (map[p] != null) ns[map[p]] = v;
    for (const [p, v] of Object.entries(state.scaleBars)) if (map[p] != null) nbars[map[p]] = v;
    state.scales = ns; state.scaleBars = nbars;
    const E = state.earthwork;
    if (E.existingPage != null) E.existingPage = map[E.existingPage] || null;
    if (E.proposedPage != null) E.proposedPage = map[E.proposedPage] || null;
    heatGrid = null; // page indices shifted — clear the session overlay
    await finalizeCombined(out, state.docName || 'plans.pdf');
    markupsChanged();
    setMsg('Sheets updated.');
  } catch (err) { console.error(err); setMsg('Could not rebuild the set: ' + err.message); }
}
$('sheetMgrCancel').addEventListener('click', () => $('sheetMgr').classList.add('hidden'));
$('sheetMgr').addEventListener('click', e => { if (e.target === $('sheetMgr')) $('sheetMgr').classList.add('hidden'); });
$('sheetMgrApply').addEventListener('click', async () => {
  const order = sheetPlan.filter(s => !s.removed).map(s => s.page);
  if (!order.length) { setMsg('Keep at least one sheet.'); return; }
  const unchanged = order.length === state.doc.numPages && order.every((p, i) => p === i + 1);
  $('sheetMgr').classList.add('hidden');
  if (!unchanged) await applySheetPlan(order);
});

/* ============================== Tools & pointer input ============================== */

function setTool(t) {
  tool = t;
  cancelOverlay();
  cancelDraft();
  if (alignDraft && t !== 'align') alignDraft = null; // keep any applied shift; drop the in-progress pair
  drag = null;
  joinPick = null; extend = null; moveEnd = null; circleCenter = null; // abandon any half-finished Join / extend / connect / Circle marquee when switching tools
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  syncToolGroups(); // reflect the active tool on the dirt-trade group faces
  els.cv.classList.toggle('crosshair', t !== 'pan' && t !== 'select');
  els.cv.style.cursor = baseCursor();
  // per-tool color memory (highlighter yellow, ink red, user overrides stick)
  if (t !== 'pan' && t !== 'select') els.mkColor.value = toolColors[t] || DEFAULT_COLOR;
  if (t === 'calibrate') {
    if (pageFtPerPx() && !state.scaleBars[state.page]) synthScaleBar(state.page); // legacy scale → editable bar
    const bar = state.scaleBars[state.page];
    setMsg(bar
      ? `Sheet ${state.page} scale: ${scaleFeetStr(bar.feet)} ft on the bar. Drag an end to adjust · drag the middle to move it · Alt-click to clear · or click two points to redo.`
      : 'Click two points a known distance apart (a dimension line, a scale bar), then enter the distance.');
  } else if (NEEDS_SCALE.includes(t) && !pageFtPerPx()) {
    setMsg('This sheet has no scale yet — calibrate first (📏).');
  } else if (t === 'plane') {
    setMsg(`Trace a roof face; finish with Enter/double-click, then set its pitch. Main pitch ${state.roofPitch}/12.`);
  } else if (t === 'redge') {
    setMsg(`Trace a ${EDGE_LABEL[($('edgeType') || {}).value] || 'roof'} edge; hip/valley/rake are pitch-corrected off the ${state.roofPitch}/12 main pitch.`);
  } else if (t === 'wand') {
    setMsg(`Auto-trace (${curSurface}) — click right on a contour; it picks up the whole line and prefills the elevation. Vector PDFs only.`);
  } else if (t === 'autoarea') {
    setMsg('Auto-area — click a closed outline (building, paving edge) on a vector PDF to pick it up as an area takeoff.');
  } else if (t === 'contour') {
    setMsg(`Trace a ${curSurface} contour; finish with Enter/double-click, then type its elevation.`);
  } else if (t === 'espot') {
    setMsg(`Click a ${curSurface} spot grade — you'll type its elevation.`);
  } else if (t === 'epad') {
    setMsg(`Trace a ${curSurface} building pad (flat at one elevation); Enter/double-click to close.`);
  } else if (t === 'ebound') {
    setMsg('Trace the limits of disturbance — the area gridded for cut/fill. Enter/double-click to close.');
  } else if (t === 'qarea') {
    setMsg('Trace a paved/graded area; Enter/double-click to close, then pick a material. Double-click it later to edit.');
  } else if (t === 'qline') {
    setMsg('Trace a run (curb, pipe, silt fence…); Enter/double-click to finish. Click the start point (or Shift+Enter) to close it into a loop.');
  } else if (t === 'qcount') {
    setMsg('Click each item to count; Enter or double-click to finish and name it.');
  } else if (t === 'dwall') {
    setMsg(`Trace a wall run (${curDwSides}-side @ ${fmt(state.drywall.wallHeight)}'); Enter/double-click to finish. Double-click a run to set its height.`);
  } else if (t === 'dceiling') {
    setMsg(`Trace a ${CEIL_LABEL[curCeilType]} ceiling outline; Enter/double-click to close.${curCeilType === 'drywall' ? '' : ' Grid, tile & hangers taken off separately. Double-click a ceiling to change its type.'}`);
  } else if (t === 'dopening') {
    setMsg(`Click each ${OPENING_LABEL[curDwOpening].toLowerCase()} (−${OPENING_DEDUCT[curDwOpening]} SF each); Enter/double-click to finish.`);
  } else if (t === 'froom') {
    setMsg(`Trace a ${FLOOR_LABEL[curFloorType]} room outline; Enter/double-click to close → floor SF. Double-click a room to change its material.`);
  } else if (t === 'ftrans') {
    setMsg(`Trace a ${TRANS_LABEL[curTransType].toLowerCase()} run; Enter/double-click to finish → LF. Double-click to change its type.`);
  } else if (t === 'fwall') {
    setMsg(`Trace a ${FRAM_SIZE_LABEL[curFramSize]} wall run (${state.framing.spacing}" OC @ ${fmt(state.framing.height)}'); Enter/double-click to finish → studs & plates. Double-click to change size.`);
  } else if (t === 'fopening') {
    setMsg(`Click each ${FOPEN_LABEL[curFopenType].toLowerCase()} (${FOPEN_W[curFopenType]}' RO default → header + king/jack/cripple studs); Enter/double-click to finish. Double-click a group to set its width.`);
  } else if (t === 'fsheath') {
    setMsg(`Trace a ${SHEATH_LABEL[curSheathType]} sheathing area; Enter/double-click to close → 4×8 sheets. Double-click to change its type.`);
  } else if (t === 'escline') {
    setMsg(`Trace a ${ESC_LINE_LABEL[curEscLine].toLowerCase()} run; Enter/double-click to finish → LF. Double-click a run to change its type.`);
  } else if (t === 'escitem') {
    setMsg(`Click each ${ESC_ITEM_LABEL[curEscItem].toLowerCase()}; Enter/double-click to finish → counted EA. Double-click a group to change its type.`);
  } else if (t === 'escarea') {
    setMsg(`Trace a ${ESC_AREA_LABEL[curEscArea].toLowerCase()} area; Enter/double-click to close → SF + materials. Double-click it to change its type.`);
  } else if (t === 'sstripe') {
    setMsg(`Trace a ${STRP_LINE_LABEL[curStrpLine]} run; Enter/double-click to finish → LF. Stall lines are already in the stall price — trace only stop bars, crosswalks, lane lines and hatching.`);
  } else if (t === 'sstall') {
    setMsg(`Click each ${STRP_STALL_LABEL[curStrpStall].toLowerCase()}; Enter/double-click to finish → counted EA (price includes painting its own lines). Double-click a group to change its type.`);
  } else if (t === 'smark') {
    setMsg(`Click each ${STRP_MARK_LABEL[curStrpMark].toLowerCase()}; Enter/double-click to finish → counted EA. Double-click a group to change its type.`);
  } else if (t === 'swall') {
    setMsg(`Trace a ${SID_MAT_LABEL[curSidMat].toLowerCase()} elevation; Enter/double-click to close → gross SF. Openings (⊡) deduct from it. Double-click a wall to change its material.`);
  } else if (t === 'sopening') {
    setMsg(`Click each ${SID_OPEN_LABEL[curSidOpen].toLowerCase()} (−${SID_OPEN_DEDUCT[curSidOpen]} SF each, plus trim); Enter/double-click to finish. Double-click a group to edit its deduct.`);
  } else if (t === 'sgutter') {
    setMsg(`Trace a ${SID_GUT_LABEL[curSidGut].toLowerCase()} run; Enter/double-click to finish → LF. Double-click a run to change its type.`);
  } else if (t === 'sinsul') {
    setMsg(`Trace a ${SID_INS_LABEL[curSidIns].toLowerCase()} area; Enter/double-click to close → SF${SID_INS_BAGGED[curSidIns] ? ' + bags' : ''}. Double-click it to change its type.`);
  } else if (t === 'dmarea') {
    setMsg(`Trace a ${DM_AREA_LABEL[curDmArea].toLowerCase()} area; Enter/double-click to close → SF → debris CY + loads. Double-click it to change its type.`);
  } else if (t === 'dmline') {
    setMsg(`Trace a ${DM_LINE_LABEL[curDmLine].toLowerCase()} run; Enter/double-click to finish → LF (removal + haul in the unit price). Double-click a run to change its type.`);
  } else if (t === 'dmitem') {
    setMsg(`Click each ${DM_ITEM_LABEL[curDmItem].toLowerCase()}; Enter/double-click to finish → counted EA (removal + haul in the unit price). Double-click a group to change its type.`);
  } else if (t === 'fnline') {
    setMsg(`Trace a ${FN_LINE_LABEL[curFnLine].toLowerCase()} run (posts every ${FN_LINE_SPACING[curFnLine]}′); Enter/double-click to finish → LF + posts. Double-click a run to change its type.`);
  } else if (t === 'fngate') {
    setMsg(`Click each ${FN_GATE_LABEL[curFnGate].toLowerCase()}; Enter/double-click to finish → counted EA. Double-click a group to change its type.`);
  } else if (t === 'lsarea') {
    setMsg(`Trace a ${LS_AREA_LABEL[curLsArea].toLowerCase()} area; Enter/double-click to close → SF → ${LS_AREA_UNIT[curLsArea]}. Double-click it to change its type.`);
  } else if (t === 'lsplant') {
    setMsg(`Click each ${LS_PLANT_LABEL[curLsPlant].toLowerCase()}; Enter/double-click to finish → counted EA. Double-click a group to change its type.`);
  } else if (t === 'lsline') {
    setMsg(`Trace a ${LS_LINE_LABEL[curLsLine].toLowerCase()} run; Enter/double-click to finish → LF. Double-click a run to change its type.`);
  } else if (t === 'lshead') {
    setMsg(`Click each ${LS_HEAD_LABEL[curLsHead].toLowerCase()}; Enter/double-click to finish → counted EA. Double-click a group to change its type.`);
  } else if (t === 'dheight') {
    setMsg((state.scales[state.page] || 0)
      ? 'On an elevation / section sheet, click the floor then the ceiling (bottom → top); double-click or Enter to finish, then name it. Set it as the default in 🧱 or double-click a wall run to apply it.'
      : "Set this sheet's scale first (📏 calibrate) — then measure the height off the elevation.");
  } else if (t === 'dtrim') {
    setMsg(`Trace a ${TRIM_LABEL[curDwTrim].toLowerCase()} run; Enter/double-click to finish → LF.`);
  } else if (t === 'align') {
    const E = state.earthwork;
    setMsg((!E.existingPage || !E.proposedPage)
      ? 'Designate the Existing and Proposed sheets in the ⛰ Dirt panel first.'
      : `Click a sharp landmark on the Existing sheet (page ${E.existingPage}) — a property corner works well.`);
  }
  vp.requestDraw(); // the scale bar (and any tool-dependent overlay) shows/hides on tool change
}
document.querySelectorAll('.tool').forEach(b => b.addEventListener('click', () => { closeToolFlyouts(); setTool(b.dataset.tool); }));
{
  const prEditOpSel = document.getElementById('prEditOp');
  if (prEditOpSel) prEditOpSel.addEventListener('change', () => setEditOp(prEditOpSel.value));
  const prEditModeSel = document.getElementById('prEditMode');
  if (prEditModeSel) prEditModeSel.addEventListener('change', () => setEditMode(prEditModeSel.value));
  const prEditRegionSel = document.getElementById('prEditRegionOp');
  if (prEditRegionSel) prEditRegionSel.addEventListener('change', () => { editRegionOp = prEditRegionSel.value; });
}

/* ---- Tool-group flyouts (dirt trade) — mirrors the sitework tool ---- */
function toolGroupOf(t) { for (const g in TOOL_GROUPS) if (TOOL_GROUPS[g].includes(t)) return g; return null; }
function syncToolGroups() {
  const g = toolGroupOf(tool);
  if (g) groupCurrent[g] = tool; // remember the last-used tool per group
  for (const grp in TOOL_GROUPS) {
    const main = document.querySelector(`.tool-group-main[data-group="${grp}"]`);
    if (!main) continue;
    const face = TOOL_FACE[groupCurrent[grp]] || grp;
    const sp = face.indexOf(' ');
    const icon = sp > 0 ? face.slice(0, sp) : face;
    const name = sp > 0 ? face.slice(sp) : '';
    main.innerHTML = `${icon}<span class="btn-label">${name}</span>`; // name hides at narrow widths
    main.classList.toggle('active', TOOL_GROUPS[grp].includes(tool));
  }
}
function closeToolFlyouts() { document.querySelectorAll('.tool-flyout').forEach(f => f.classList.add('hidden')); }
// flyout is position:fixed, placed under its group so no ancestor overflow clips it
function toggleFlyout(grp, anchor) {
  const fly = document.querySelector(`.tool-flyout[data-flyout="${grp}"]`);
  if (!fly) return;
  const willOpen = fly.classList.contains('hidden');
  closeToolFlyouts();
  if (willOpen) {
    const r = anchor.closest('.tool-group').getBoundingClientRect();
    fly.style.top = `${r.bottom + 4}px`;
    fly.style.left = `${r.left}px`;
    fly.classList.remove('hidden');
  }
}
document.querySelectorAll('.tool-group-main, .tool-group-caret').forEach(el =>
  el.addEventListener('click', e => { e.stopPropagation(); toggleFlyout(el.dataset.group, el); }));
document.addEventListener('click', e => { if (!e.target.closest('.tool-group')) closeToolFlyouts(); });
syncToolGroups(); // initial faces

const screenPt = e => {
  const r = els.cv.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};

els.cv.addEventListener('pointerdown', e => {
  if (e.button !== 0 && e.button !== 1) return;
  e.preventDefault();
  commitOverlay(); // clicking the canvas places any pending note first
  const s = screenPt(e);
  const w = vp.screenToWorld(s.x, s.y);
  els.cv.setPointerCapture(e.pointerId);

  // middle button always pans; pan tool pans
  if (e.button === 1 || tool === 'pan') {
    drag = { mode: 'pan', ptr: e.pointerId, last: { x: e.clientX, y: e.clientY } };
    els.cv.classList.add('grabbing');
    return;
  }
  if (!state.doc) return;

  // scale calibration: edit the existing bar, or two clicks + the real distance
  if (tool === 'calibrate') {
    const bar = state.scaleBars[state.page];
    if (bar && (!calibPts || !calibPts.length)) {
      const end = scaleBarHandle(bar, w);
      if (end) { drag = { mode: 'scalebar', ptr: e.pointerId, end }; return; } // drag an endpoint to adjust
      if (e.altKey && projOnSeg(bar.a, bar.b, w).d <= Math.max(9 / vp.view.zoom, 4)) { clearScale(state.page); return; } // Alt-click the bar → clear
      // drag the middle of the bar to reposition it — feet AND pixel length stay
      // fixed, so the scale is unchanged (just moved)
      if (projOnSeg(bar.a, bar.b, w).d <= Math.max(9 / vp.view.zoom, 4)) {
        drag = { mode: 'scalebarmove', ptr: e.pointerId, from: { x: w.x, y: w.y }, origA: { ...bar.a }, origB: { ...bar.b } };
        return;
      }
    }
    const p = { x: w.x, y: w.y };
    if (!calibPts || !calibPts.length) {
      calibPts = [p];
      setMsg('Now click the second point of the known distance.');
    } else {
      const a = calibPts[0];
      calibPts = null;
      const px = dist(a.x, a.y, p.x, p.y);
      if (px < 4) { setMsg('Those points are on top of each other — click two points a known distance apart.'); vp.requestDraw(); return; }
      modals.askNumber('Real-world distance between the two points',
        "Feet (e.g. 50). Sets this sheet's scale — every measurement on it updates live.", '', null)
        .then(ftv => {
          if (ftv && ftv > 0) {
            state.scaleBars[state.page] = { a: { x: a.x, y: a.y }, b: { x: p.x, y: p.y }, feet: ftv };
            applyScaleBar(state.page);
            scheduleSave(); markupsChanged();
            setMsg(`Scale set for sheet ${state.page}: ${fmt(ftv, ftv < 10 ? 1 : 0)} ft. Drag the bar's ends to fine-tune, or Alt-click it to clear.`);
          } else setMsg('Calibration cancelled.');
          vp.requestDraw();
        });
    }
    vp.requestDraw();
    return;
  }

  // spot elevation: one click = one markup + elevation prompt
  if (tool === 'espot') {
    const prev = snapshot();
    const surf = curSurface;
    const m = { id: randId(), page: state.page, kind: 'espot', surface: surf, color: curColor(), width: curWidth(), pts: [{ x: w.x, y: w.y }], elev: null, created: Date.now() };
    state.markups.push(m);
    pushUndo(prev);
    markupsChanged();
    modals.askNumber(`Spot elevation (ft) — ${surf}`, 'e.g. 812.5', lastElev[surf] != null ? lastElev[surf] : '', 1)
      .then(v => { if (v != null) { m.elev = v; lastElev[surf] = v; markupsChanged(); } });
    return;
  }

  // auto-trace wand: one click snaps to the nearest vector line as a contour
  if (tool === 'wand') { wandTrace(w); return; }
  if (tool === 'autoarea') { wandArea(w); return; } // closed boundary → area takeoff

  // two-sheet alignment: landmark on existing, its match on proposed
  if (tool === 'align') {
    const E = state.earthwork;
    if (!E.existingPage || !E.proposedPage) { setMsg('Designate the Existing and Proposed sheets first (⛰ Dirt panel).'); return; }
    if (E.existingPage === E.proposedPage) { setMsg('Both surfaces are on the same sheet — no alignment needed.'); return; }
    if (!alignDraft) alignDraft = { pts: [], qs: [], prevAlign: { ...E.align } };
    if (alignDraft.pts.length === alignDraft.qs.length) {
      // expecting a landmark on the EXISTING sheet
      if (state.page !== E.existingPage) { setPage(E.existingPage); setMsg(`Jumped to the Existing sheet (page ${E.existingPage}) — click a sharp landmark (a property corner).`); return; }
      alignDraft.pts.push({ x: w.x, y: w.y });
      setPage(E.proposedPage);
      setMsg('Now click that SAME landmark on the Proposed sheet' + (alignIsSet() ? ' (the ⌖ cross marks where the current alignment predicts it).' : '.'));
    } else {
      // its match on the PROPOSED sheet
      if (state.page !== E.proposedPage) { setPage(E.proposedPage); setMsg(`Jumped to the Proposed sheet (page ${E.proposedPage}) — click the matching landmark.`); return; }
      alignDraft.qs.push({ x: w.x, y: w.y });
      if (alignDraft.qs.length === 1) {
        const p = alignDraft.pts[0], q = alignDraft.qs[0];
        E.align = { a: 1, b: 0, e: p.x - q.x, f: p.y - q.y }; // pair 1: shift only
        scheduleSave(); renderDirtPanel();
        setPage(E.existingPage);
        setMsg('Shift applied. Press Enter to finish, or click a SECOND landmark (far from the first) to also fix rotation & scale.');
      } else {
        const [p1, p2] = alignDraft.pts, [q1, q2] = alignDraft.qs;
        const dqx = q2.x - q1.x, dqy = q2.y - q1.y;
        const dpx = p2.x - p1.x, dpy = p2.y - p1.y;
        const len2 = dqx * dqx + dqy * dqy;
        if (Math.sqrt(len2) < 20) {
          alignDraft.pts.pop(); alignDraft.qs.pop();
          setPage(E.existingPage);
          setMsg('Those landmarks are too close together — click a second landmark farther from the first.');
          vp.requestDraw();
          return;
        }
        const a = (dqx * dpx + dqy * dpy) / len2;
        const b = (dqx * dpy - dqy * dpx) / len2;
        E.align = { a, b, e: p1.x - (a * q1.x - b * q1.y), f: p1.y - (b * q1.x + a * q1.y) };
        alignDraft = null;
        scheduleSave(); renderDirtPanel();
        setMsg('Sheets aligned (shift + rotation + scale). Turn on Ghost in the ⛰ Dirt panel to double-check the fit.');
        setTool('pan');
      }
    }
    vp.requestDraw();
    return;
  }

  // click-built tools: measures (length/area/count) + roofing (plane/edge/item)
  if (CLICK_TOOLS.includes(tool)) {
    if (NEEDS_SCALE.includes(tool) && !pageFtPerPx()) {
      setMsg('This sheet has no scale yet — calibrate it first (📏): click two points a known distance apart.');
      setTool('calibrate');
      return;
    }
    // grab an already-placed vertex to reposition it, instead of adding a new one
    if (draft && !POINT_KINDS.includes(draft.kind)) {
      const gi = draftGrabIndex(w);
      if (gi >= 0) { draftDrag = { i: gi, ptr: e.pointerId, prev: JSON.stringify(draft.pts), moved: false }; return; }
    }
    if (!draft) draft = { kind: tool, pts: [], prev: snapshot(), past: [], future: [] };
    const prevPts = JSON.stringify(draft.pts);
    draft.pts.push({ x: w.x, y: w.y });
    draftRecord(prevPts);
    if (draft.kind === 'mcount' || draft.kind === 'ritem') setMsg(`${draft.pts.length} clicked — Enter or double-click to finish.`);
    vp.requestDraw();
    return;
  }

  if (tool === 'select') {
    const ctx = vp.ctx;
    const sel = selMarkup();
    // Box / Circle marquee edit modes act on the selected reshapeable shape.
    if (editMode !== 'points' && sel && sel.page === state.page && canReshape(sel)) {
      if (editMode === 'box') { undoCapture = null; drag = { mode: 'marquee-box', ptr: e.pointerId, from: w, cur: w, moved: false }; vp.requestDraw(); return; }
      if (editMode === 'circle') { handleCircleClick(sel, w); return; }
    }
    // Join op — connect to a loose end, then lay points / weld / pan (decided at
    // pointerup by doExtendClick / the pan branch of endDrag).
    if (editMode === 'points' && editOp === 'join' && !e.altKey) {
      if (extend) {
        // Connected: defer — a plain click lays a point or welds; a drag pans.
        drag = { mode: 'pan', ptr: e.pointerId, last: { x: e.clientX, y: e.clientY }, from: { x: e.clientX, y: e.clientY }, moved: false, extendAt: w };
        els.cv.classList.add('grabbing');
        return;
      }
      const hitEnd = endpointNear(w, Math.max(11 / vp.view.zoom, 7));
      if (hitEnd) {
        selectedId = hitEnd.m.id;
        extend = { id: hitEnd.m.id, atFront: hitEnd.vi === 0 };
        setMsg('Connected to a loose end — click to lay a point, click another loose end to weld, drag to pan, Enter / Esc / double-click to finish.');
        // a drag from here pans; a plain release just stays connected
        drag = { mode: 'pan', ptr: e.pointerId, last: { x: e.clientX, y: e.clientY }, from: { x: e.clientX, y: e.clientY }, moved: false };
        els.cv.classList.add('grabbing');
        renderMarkupList(); vp.requestDraw();
        return;
      }
      // not on a loose end → fall through to normal select / pan
    }
    // Move op, already connected: a tap on ANY loose end welds (handled at
    // pointerup); a drag on it moves that point instead. Lets you weld a second,
    // not-yet-selected line's end, not just the selected line's own other end.
    if (editMode === 'points' && editOp === 'move' && moveEnd && !e.altKey) {
      const hitEnd = endpointNear(w, Math.max(11 / vp.view.zoom, 7));
      if (hitEnd) {
        selectedId = hitEnd.m.id;
        undoCapture = snapshot();
        drag = { mode: 'handle', ptr: e.pointerId, id: hitEnd.m.id, hi: hitEnd.vi, moved: false, isEnd: true, t0: Date.now() };
        return;
      }
    }
    if (sel && sel.page === state.page) {
      const hi = hitHandle(ctx, sel, w);
      // Alt-click reshapes the vertex set: on a point → remove it; on an edge →
      // add one; Shift+Alt-click a segment → cut the line there (split in two).
      if (e.altKey && canReshape(sel)) {
        if (hi >= 0) { deleteHandle(sel, hi); return; }
        const tol = Math.max(8 / vp.view.zoom, 4);
        if (e.shiftKey) {
          const edge = nearestEdge(sel, w, tol);
          if (edge) {
            if (isOpenPoly(sel)) cutAtEdge(sel, edge.i);
            else setMsg('Cutting works on open lines (contours), not closed shapes.');
            return;
          }
        } else if (insertHandle(sel, w, tol)) {
          return;
        }
      }
      // Explicit edit-mode ops (Edit-points dropdown) — the click-free equivalent
      // of the Alt-click shortcuts above. Only when reshapeable and no modifier is
      // held; a click that hits nothing falls through to Move / reselect below.
      if (canReshape(sel) && !e.altKey) {
        const tol = Math.max(8 / vp.view.zoom, 4);
        if (editOp === 'remove' && hi >= 0) { deleteHandle(sel, hi); return; }
        if (editOp === 'add') { if (insertHandle(sel, w, tol)) return; }
        if (editOp === 'cut') {
          const edge = nearestEdge(sel, w, tol);
          if (edge) {
            if (isOpenPoly(sel)) cutAtEdge(sel, edge.i);
            else setMsg('Cutting works on open lines (contours), not closed shapes.');
            return;
          }
        }
      }
      if (hi >= 0) {
        undoCapture = snapshot();
        // isEnd + t0 let a motionless quick tap on a loose end connect / join in Move op.
        const isEnd = isOpenPoly(sel) && (hi === 0 || hi === sel.pts.length - 1);
        drag = { mode: 'handle', ptr: e.pointerId, id: sel.id, hi, moved: false, isEnd, t0: Date.now() };
        return;
      }
    }
    const hit = hitMarkup(ctx, w);
    if (hit) {
      if (hit.id !== selectedId) setEditOp('move'); // a fresh selection starts in Move (no surprise deletes)
      selectedId = hit.id;
      undoCapture = snapshot();
      drag = { mode: 'move', ptr: e.pointerId, id: hit.id, from: w, orig: JSON.parse(JSON.stringify(hit.pts)), moved: false };
      if (canReshape(hit)) setMsg(isOpenPoly(hit)
        ? 'Drag a point to reshape · Alt-click: add / remove a point · Shift+Alt-click a segment: cut the line.'
        : 'Drag a point to reshape · Alt-click an edge to add a point · Alt-click a point to remove it.');
      renderMarkupList();
      vp.requestDraw();
    } else {
      // Don't deselect yet — only a click on empty space clears the selection; a
      // drag here is a pan and must keep you in edit mode. Deselect is decided at
      // pointerup (endDrag) based on whether the pan actually moved.
      drag = { mode: 'pan', ptr: e.pointerId, last: { x: e.clientX, y: e.clientY }, from: { x: e.clientX, y: e.clientY }, deselect: !!selectedId, moved: false };
      els.cv.classList.add('grabbing');
    }
    return;
  }

  if (tool === 'text') {
    openOverlay({ mode: 'new-text', anchor: w });
    return;
  }

  // drawing tools (incl. callout: drag from target to note position)
  undoCapture = snapshot();
  const base = { id: randId(), page: state.page, kind: tool, color: curColor(), width: curWidth(), created: Date.now() };
  const markup = tool === 'freehand'
    ? { ...base, pts: [w] }
    : { ...base, pts: [w, { x: w.x, y: w.y }] };
  drag = { mode: 'draw', ptr: e.pointerId, markup, from: s, moved: false };
});

// ---- Context cursor: tell the user what a click will do here ----------------
// A compact custom 4-arrow "move" so a draggable POINT reads a touch smaller than
// the shape body (which uses the full system `move`). White glyph, black outline
// for contrast on any sheet; hotspot centered on the 20×20 art.
const MOVE_PT_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 20 20'><path d='M10 2 L13.5 5.5 L11.5 5.5 L11.5 8.5 L14.5 8.5 L14.5 6.5 L18 10 L14.5 13.5 L14.5 11.5 L11.5 11.5 L11.5 14.5 L13.5 14.5 L10 18 L6.5 14.5 L8.5 14.5 L8.5 11.5 L5.5 11.5 L5.5 13.5 L2 10 L5.5 6.5 L5.5 8.5 L8.5 8.5 L8.5 5.5 L6.5 5.5 Z' fill='#fff' stroke='#000' stroke-width='1' stroke-linejoin='round'/></svg>";
const CURSOR_MOVE_PT = `url("data:image/svg+xml,${encodeURIComponent(MOVE_PT_SVG)}") 8 8, move`;
// The cursor when hovering nothing interactive, per tool/mode.
function baseCursor() {
  if (tool === 'pan') return 'grab';
  if (tool !== 'select' || editMode !== 'points') return 'crosshair'; // draw tools / box-circle place points
  return 'grab'; // select + points: empty space pans
}
// Refined cursor for what's under the pointer (null → fall back to baseCursor).
function hoverCursor(w) {
  if (!state.doc || tool !== 'select' || editMode !== 'points') return null;
  const ctx = vp.ctx, tol = Math.max(11 / vp.view.zoom, 7);
  // Extend session (Join op, connected): weld on a loose end, lay a point on empty.
  if (extend) return endpointNear(w, tol) ? 'pointer' : 'crosshair';
  const sel = selMarkup();
  if (sel && sel.page === state.page && canReshape(sel)) {
    const hi = hitHandle(ctx, sel, w);
    if (hi >= 0) {
      const isEnd = isOpenPoly(sel) && (hi === 0 || hi === sel.pts.length - 1);
      if (editOp === 'remove') return 'crosshair';                  // click removes this point
      if (isEnd && (editOp === 'join' || moveEnd)) return 'pointer'; // click connects / welds
      return CURSOR_MOVE_PT;                                         // drag this point (smaller move)
    }
    const edge = nearestEdge(sel, w, tol);
    if (edge) {
      if (editOp === 'add') return 'copy';                          // click adds a point here
      if (editOp === 'cut' && isOpenPoly(sel)) return 'crosshair';  // click cuts the line here
    }
  }
  // Connect / weld targets across shapes (Move-op connected, or Join op).
  if ((moveEnd || editOp === 'join') && endpointNear(w, tol)) return 'pointer';
  const hm = hitMarkup(ctx, w);
  if (hm) return hm.id === selectedId ? 'move' : 'pointer';         // drag the selected shape / click to select another
  return null;                                                       // empty → base (pan)
}
// The cursor for the current instant — the drag state wins, else hover.
function cursorFor(w) {
  if (drag) {
    if (drag.mode === 'pan') return 'grabbing';
    if (drag.mode === 'handle') return CURSOR_MOVE_PT; // dragging a single point
    if (drag.mode === 'move') return 'move';           // dragging the whole shape
    return 'crosshair'; // marquee / draw
  }
  if (draftDrag) return CURSOR_MOVE_PT; // repositioning a draft vertex
  return hoverCursor(w) || baseCursor();
}
function refreshCursor(e) { const s = screenPt(e); els.cv.style.cursor = cursorFor(vp.screenToWorld(s.x, s.y)); }

els.cv.addEventListener('pointermove', e => {
  refreshCursor(e); // hover feedback + drag-state cursor, every move
  if (draftDrag && e.pointerId === draftDrag.ptr) { // reposition an existing draft vertex
    const s = screenPt(e);
    const w = vp.screenToWorld(s.x, s.y);
    if (draft && draft.pts[draftDrag.i]) { draft.pts[draftDrag.i] = { x: w.x, y: w.y }; draftDrag.moved = true; }
    vp.requestDraw();
    return;
  }
  if ((draft || calibPts) && !draftDrag) { // rubber-band the in-progress measure/calibration
    const sp = screenPt(e);
    hoverW = vp.screenToWorld(sp.x, sp.y);
    vp.requestDraw();
  }
  if (circleCenter && !drag) { // preview the Circle marquee radius between its two clicks
    const sp = screenPt(e);
    hoverW = vp.screenToWorld(sp.x, sp.y);
    vp.requestDraw();
  }
  if (extend && !drag) { // rubber-band from the connected end to the cursor
    const sp = screenPt(e);
    hoverW = vp.screenToWorld(sp.x, sp.y);
    vp.requestDraw();
  }
  if (!drag || e.pointerId !== drag.ptr) return;
  if (drag.mode === 'marquee-box') {
    const sp2 = screenPt(e);
    drag.cur = vp.screenToWorld(sp2.x, sp2.y);
    vp.requestDraw();
    return;
  }
  const s = screenPt(e);
  const w = vp.screenToWorld(s.x, s.y);
  if (drag.mode === 'scalebar') {
    const bar = state.scaleBars[state.page];
    if (bar) { bar[drag.end] = { x: w.x, y: w.y }; applyScaleBar(state.page); vp.requestDraw(); }
    return;
  }
  if (drag.mode === 'scalebarmove') {
    const bar = state.scaleBars[state.page];
    if (bar) {
      const dx = w.x - drag.from.x, dy = w.y - drag.from.y;
      bar.a = { x: drag.origA.x + dx, y: drag.origA.y + dy };
      bar.b = { x: drag.origB.x + dx, y: drag.origB.y + dy };
      vp.requestDraw(); // length unchanged → scale unchanged
    }
    return;
  }
  if (drag.mode === 'pan') {
    vp.panPx(e.clientX - drag.last.x, e.clientY - drag.last.y);
    drag.last = { x: e.clientX, y: e.clientY };
    if (drag.from && Math.hypot(e.clientX - drag.from.x, e.clientY - drag.from.y) > 4) drag.moved = true;
    return;
  }
  if (drag.mode === 'draw') {
    const m = drag.markup;
    if (m.kind === 'freehand') m.pts.push(w);
    else m.pts[1] = w;
    if (Math.hypot(s.x - drag.from.x, s.y - drag.from.y) > 4) drag.moved = true;
    vp.requestDraw();
    return;
  }
  const m = selMarkup();
  if (!m) return;
  if (drag.mode === 'move') {
    const dx = w.x - drag.from.x, dy = w.y - drag.from.y;
    m.pts = drag.orig.map(p => ({ x: p.x + dx, y: p.y + dy }));
    drag.moved = true;
    vp.requestDraw();
    return;
  }
  if (drag.mode === 'handle') {
    drag.moved = true;
    if (['rect', 'ellipse', 'cloud', 'highlight'].includes(m.kind)) {
      const r = normRect(m.pts[0], m.pts[1]);
      const corners = [
        { x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
      const opposite = corners[(drag.hi + 2) % 4];
      m.pts = [opposite, { x: w.x, y: w.y }];
    } else if (m.kind === 'callout') {
      m.pts[1] = { x: w.x, y: w.y };
    } else if (hasHoles(m)) {
      const ref = handleRef(m, drag.hi); // drag an outer / hole vertex, then rebuild the keyhole
      if (ref) { ref.ring[ref.vi] = { x: w.x, y: w.y }; m.pts = buildKeyhole(m.outer, m.holes); }
    } else if (m.pts[drag.hi]) {
      m.pts[drag.hi] = { x: w.x, y: w.y }; // move a single vertex (line/arrow + any polyline/polygon)
    }
    vp.requestDraw();
  }
});

function endDrag(e) {
  if (draftDrag && e.pointerId === draftDrag.ptr) { // finished repositioning a draft vertex
    const dd = draftDrag; draftDrag = null;
    if (dd.moved && draft) draftRecord(dd.prev); // one undo step for the whole move
    else if (draft) tryDraftJoin(dd.i);          // a click (no drag) on a vertex → close the shape to it
    vp.requestDraw();
    return;
  }
  if (!drag || e.pointerId !== drag.ptr) return;
  const d = drag;
  drag = null;
  els.cv.classList.remove('grabbing');
  els.cv.style.cursor = cursorFor(vp.screenToWorld(screenPt(e).x, screenPt(e).y)); // back to hover feedback

  if (d.mode === 'marquee-box') {
    const m = selMarkup();
    // require a real drag, not a click: the box must span a few screen pixels
    const spanPx = Math.max(Math.abs(d.cur.x - d.from.x), Math.abs(d.cur.y - d.from.y)) * vp.view.zoom;
    if (m && spanPx >= 3) applyRegionOp(m, boxRegion(d.from, d.cur));
    vp.requestDraw();
    return;
  }

  if (d.mode === 'pan') {
    // While connected, a click (no pan) lays a point or welds; a real pan just moves the view.
    if (d.extendAt && !d.moved && extend) { doExtendClick(d.extendAt); return; }
    // A tap on empty space cancels a pending Move-op connect (before it deselects).
    if (!d.moved && moveEnd) { moveEnd = null; setMsg('Disconnected.'); vp.requestDraw(); return; }
    // a click on empty space (no pan movement) clears the selection; a real pan keeps it
    if (d.deselect && !d.moved && selectedId) { selectedId = null; renderMarkupList(); vp.requestDraw(); }
    return;
  }

  if (d.mode === 'scalebar') { applyScaleBar(state.page); scheduleSave(); markupsChanged(); return; }
  if (d.mode === 'scalebarmove') { scheduleSave(); return; } // repositioned only; scale unchanged

  if (d.mode === 'draw') {
    const m = d.markup;
    if (m.kind === 'callout') {
      // drag went target→note position: pts = [note anchor, target]
      const target = m.pts[0];
      const anchor = d.moved ? m.pts[1] : { x: target.x + 90 / vp.view.zoom, y: target.y - 70 / vp.view.zoom };
      m.pts = [anchor, target];
      openOverlay({ mode: 'new-callout', markup: m });
      vp.requestDraw();
      return;
    }
    if (!d.moved) { vp.requestDraw(); return; } // a click, not a shape
    if (m.kind === 'freehand') m.pts = simplifyPts(m.pts, 1.2 / vp.view.zoom);
    state.markups.push(m);
    selectedId = null;
    pushUndo(undoCapture); undoCapture = null;
    markupsChanged();
    return;
  }

  if ((d.mode === 'move' || d.mode === 'handle') && d.moved) {
    const m = selMarkup();
    if (m) { m.modified = Date.now(); invalidateForKind(m); }
    // A holed area was dragged as its keyhole m.pts — carry m.outer/m.holes the
    // same delta so the metadata (perimeter, future holes) stays in sync.
    if (m && d.mode === 'move' && hasHoles(m) && d.orig && d.orig[0] && m.pts[0]) {
      const dx = m.pts[0].x - d.orig[0].x, dy = m.pts[0].y - d.orig[0].y;
      const shift = ring => ring.map(p => ({ x: p.x + dx, y: p.y + dy }));
      m.outer = shift(m.outer); m.holes = m.holes.map(shift);
      m.pts = buildKeyhole(m.outer, m.holes);
    }
    pushUndo(undoCapture); undoCapture = null;
    markupsChanged();
    moveEnd = null; // a real drag is a Move, not a connect/join
  } else {
    undoCapture = null;
    // MOVE op: a motionless, quick tap on a loose end connects, then joins.
    if (d.mode === 'handle' && d.isEnd && editOp === 'move' && (Date.now() - d.t0) <= TAP_MS) {
      handleMoveTap(d.id, d.hi);
    }
  }
}
els.cv.addEventListener('pointerup', endDrag);
els.cv.addEventListener('pointercancel', endDrag);

/* ---- click-built measure drafts: commit / cancel ---- */

const CLOSED_KINDS = ['marea', 'plane', 'epad', 'ebound', 'qarea', 'dceiling', 'froom', 'fsheath', 'escarea', 'swall', 'sinsul', 'dmarea', 'lsarea']; // 3+ pts, closed polygon
const POINT_KINDS = ['mcount', 'ritem', 'qcount', 'dopening', 'fopening', 'escitem', 'sstall', 'smark', 'sopening', 'dmitem', 'fngate', 'lsplant', 'lshead']; // 1+ pts, no rubber band

/* ---- vertex reshaping: drag a point (handled in the pointer flow), Alt-click
   an edge to insert a point, Alt-click a point to remove it ---- */
const canReshape = m => !!m && !RESHAPE_NONEDIT.has(m.kind) && Array.isArray(m.pts);
const minPtsFor = m => (m.kind === 'line' || m.kind === 'arrow') ? 2 : (CLOSED_KINDS.includes(m.kind) ? 3 : 2);
function projOnSeg(a, b, p) {
  const vx = b.x - a.x, vy = b.y - a.y, L2 = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / L2));
  const x = a.x + t * vx, y = a.y + t * vy;
  return { x, y, d: Math.hypot(p.x - x, p.y - y) };
}
// closest polygon/polyline edge to w within tol → { i, p } for splice(i+1), or null
function nearestEdge(m, w, tol) {
  if (!m.pts || m.pts.length < 2) return null;
  const closed = CLOSED_KINDS.includes(m.kind), n = m.pts.length, segs = closed ? n : n - 1;
  let best = null;
  for (let i = 0; i < segs; i++) {
    const pr = projOnSeg(m.pts[i], m.pts[(i + 1) % n], w);
    if (pr.d <= tol && (!best || pr.d < best.d)) best = { i, p: { x: pr.x, y: pr.y }, d: pr.d };
  }
  return best;
}
// reshaping an earthwork surface invalidates the last cut/fill result
function invalidateForKind(m) { if (m && ['contour', 'epad', 'ebound'].includes(m.kind)) state.earthwork.result = null; }
function insertVertexAt(m, edge) {
  const prev = snapshot();
  m.pts.splice(edge.i + 1, 0, edge.p);
  m.modified = Date.now(); invalidateForKind(m);
  pushUndo(prev); markupsChanged(); setMsg('Point added.');
}
function deleteVertexAt(m, hi) {
  if (m.pts.length <= minPtsFor(m)) { setMsg(`A ${MK_LABEL[m.kind] || 'shape'} needs at least ${minPtsFor(m)} points.`); return; }
  const prev = snapshot();
  m.pts.splice(hi, 1);
  m.modified = Date.now(); invalidateForKind(m);
  pushUndo(prev); markupsChanged(); setMsg('Point removed.');
}
// Only open polylines can be cut/split (closed shapes must stay closed).
const isOpenPoly = m => canReshape(m) && !CLOSED_KINDS.includes(m.kind);
// Cut an open polyline at segment i → two independent lines that keep the
// original's kind/elevation/etc. A piece with fewer than 2 points is dropped, so
// a point is never left stranded on its own.
function cutAtEdge(m, i) {
  const pieces = [m.pts.slice(0, i + 1), m.pts.slice(i + 1)].filter(p => p.length >= 2);
  const idx = state.markups.indexOf(m);
  if (idx < 0) return;
  const prev = snapshot();
  const clones = pieces.map(p => ({ ...JSON.parse(JSON.stringify(m)), id: randId(), pts: p, created: Date.now(), modified: Date.now() }));
  state.markups.splice(idx, 1, ...clones); // replace the original with the surviving piece(s)
  selectedId = clones.length ? clones.reduce((a, b) => b.pts.length > a.pts.length ? b : a).id : null;
  invalidateForKind(m);
  pushUndo(prev); markupsChanged();
  setMsg(clones.length === 2 ? 'Line cut in two — select and delete the piece you don’t want.'
    : clones.length === 1 ? 'Line cut — the stray single point was dropped.'
    : 'Line removed — nothing long enough was left.');
}

// ---- Join: weld two open-line endpoints (two-click). Merges two separate lines
// into one, or closes a single line's two ends into a loop. `joinPick` holds the
// first-picked end between the two clicks. Returns true when the click was
// consumed (so the caller doesn't also select/pan); false lets it fall through.
const endpointsOf = m => { const n = m.pts.length; return [[0, m.pts[0]], [n - 1, m.pts[n - 1]]]; };
function selEndpointNear(m, w, tol) {
  let best = -1, bd = tol;
  for (const [vi, p] of endpointsOf(m)) { const d = Math.hypot(w.x - p.x, w.y - p.y); if (d <= bd) { bd = d; best = vi; } }
  return best;
}
function endpointNear(w, tol) {
  let best = null;
  for (const m of state.markups) {
    if (m.page !== state.page || !isOpenPoly(m) || !markupShown(m)) continue;
    for (const [vi, p] of endpointsOf(m)) {
      const d = Math.hypot(w.x - p.x, w.y - p.y);
      if (d <= tol && (!best || d < best.d)) best = { m, vi, d };
    }
  }
  return best;
}
function handleJoin(sel, w) {
  if (!isOpenPoly(sel)) { setMsg('Join connects open lines (contours), not closed shapes.'); return true; }
  const tol = Math.max(11 / vp.view.zoom, 7);
  if (!joinPick) {
    const vi = selEndpointNear(sel, w, tol);
    if (vi < 0) return false; // not on a loose end → let the click select / pan
    joinPick = { id: sel.id, vi };
    setMsg('Join: click another loose end — this line’s other end to close it, or another line of the same type to merge.');
    vp.requestDraw();
    return true;
  }
  const target = endpointNear(w, tol);
  if (!target) { joinPick = null; setMsg('Join canceled — pick a loose end to try again.'); vp.requestDraw(); return true; }
  const a = state.markups.find(m => m.id === joinPick.id);
  if (!a) { joinPick = null; return true; }
  const b = target.m, aVi = joinPick.vi, bVi = target.vi;
  if (a.id === b.id && aVi === bVi) { setMsg('Join: pick the other end.'); return true; }
  if (a.kind !== b.kind) { setMsg('Join: the two lines must be the same type.'); return true; }
  const prev = snapshot();
  if (a.id === b.id) {
    if (a.pts.length < 3) { setMsg('Join: a loop needs at least 3 points.'); joinPick = null; return true; }
    a.pts.push({ x: a.pts[0].x, y: a.pts[0].y }); // close the loop with a real closing segment
  } else {
    const aPts = aVi === 0 ? a.pts.slice().reverse() : a.pts.slice(); // picked end becomes last
    const bPts = bVi === 0 ? b.pts.slice() : b.pts.slice().reverse(); // picked end becomes first
    a.pts = aPts.concat(bPts);
    const bi = state.markups.indexOf(b); if (bi >= 0) state.markups.splice(bi, 1);
  }
  a.modified = Date.now(); invalidateForKind(a);
  selectedId = a.id; joinPick = null;
  pushUndo(prev); markupsChanged(); setMsg('Joined.'); vp.requestDraw();
  return true;
}

// Weld the active end of `a` (aVi) onto another loose end `b`/`bVi` — same math as
// handleJoin: close a single line into a loop, or merge two lines into one.
function weldEnds(a, aVi, b, bVi) {
  if (a.kind !== b.kind) { setMsg('Join: the two lines must be the same type.'); return; }
  const prev = snapshot();
  if (a.id === b.id) {
    if (a.pts.length < 3) { setMsg('Join: a loop needs at least 3 points.'); return; }
    a.pts.push({ x: a.pts[0].x, y: a.pts[0].y });
  } else {
    const aPts = aVi === 0 ? a.pts.slice().reverse() : a.pts.slice();
    const bPts = bVi === 0 ? b.pts.slice() : b.pts.slice().reverse();
    a.pts = aPts.concat(bPts);
    const bi = state.markups.indexOf(b); if (bi >= 0) state.markups.splice(bi, 1);
  }
  a.modified = Date.now(); invalidateForKind(a);
  selectedId = a.id;
  pushUndo(prev); markupsChanged(); setMsg('Joined.'); vp.requestDraw();
}

// Can two loose ends be welded? Same line type; for one line's own two ends, they
// must be distinct and have at least one point between them (a real loop).
function canJoinEnds(a, aVi, b, bVi) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.id === b.id) return aVi !== bVi && a.pts.length >= 3;
  return true;
}
// MOVE op: a motionless tap on a loose end. First tap connects (moveEnd); a second
// tap on another matching end welds them; tapping the connected end disconnects.
function handleMoveTap(id, vi) {
  const b = state.markups.find(m => m.id === id);
  if (!b || !isOpenPoly(b)) { moveEnd = null; return; }
  if (!moveEnd) {
    moveEnd = { id, vi };
    setMsg('Connected to an endpoint — tap the other end to join; drag to move it instead.');
    vp.requestDraw();
    return;
  }
  if (moveEnd.id === id && moveEnd.vi === vi) { moveEnd = null; setMsg('Disconnected.'); vp.requestDraw(); return; }
  const a = state.markups.find(m => m.id === moveEnd.id);
  if (canJoinEnds(a, moveEnd.vi, b, vi)) { weldEnds(a, moveEnd.vi, b, vi); moveEnd = null; return; }
  moveEnd = { id, vi }; // not a valid pair → move the connection to the tapped end
  setMsg(a && a.kind !== b.kind ? 'Those are different line types — can’t join.' : 'Connected — tap a matching loose end to join.');
  vp.requestDraw();
}

// A click while connected (extend session): on another loose end → weld to it (or
// close the loop); on empty space → lay a point extending the connected end.
function doExtendClick(w) {
  const a = state.markups.find(m => m.id === extend.id);
  if (!a || !isOpenPoly(a) || !a.pts || !a.pts.length) { extend = null; hoverW = null; vp.requestDraw(); return; }
  const activeVi = extend.atFront ? 0 : a.pts.length - 1;
  const target = endpointNear(w, Math.max(11 / vp.view.zoom, 7));
  if (target && !(target.m.id === a.id && target.vi === activeVi)) {
    weldEnds(a, activeVi, target.m, target.vi); // to another end, or the shape's own other end (loop)
    extend = null; hoverW = null;
    return;
  }
  const prev = snapshot();
  const pt = { x: w.x, y: w.y };
  if (extend.atFront) a.pts.unshift(pt); else a.pts.push(pt); // active end stays the growing end
  a.modified = Date.now(); invalidateForKind(a);
  pushUndo(prev); markupsChanged(); vp.requestDraw();
}

// Shift+Enter during an extend session: weld the connected end to the shape's
// other end (a closed loop), then finish. weldEnds needs ≥3 points for a loop;
// with fewer it just finishes.
function closeExtendLoop() {
  const a = extend && state.markups.find(m => m.id === extend.id);
  if (a && isOpenPoly(a) && a.pts.length >= 3) {
    const activeVi = extend.atFront ? 0 : a.pts.length - 1;
    weldEnds(a, activeVi, a, extend.atFront ? a.pts.length - 1 : 0);
  } else {
    setMsg('Finished.');
  }
  extend = null; hoverW = null; vp.requestDraw();
}

// ---- Holes (keyhole model) ----------------------------------------------------
// A holed area keeps the outer ring in m.outer and hole rings in m.holes; m.pts is
// the derived "keyhole" ring (outer + a zero-width bridge into each hole, wound
// opposite) that every existing consumer already reads — so area (shoelace nets
// out), fill (nonzero winding), hit-test and earthwork all stay correct with no
// engine changes. Plain areas carry neither field and m.pts is just the ring.
const hasHoles = m => Array.isArray(m.holes) && m.holes.length > 0;
function ringSignedArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) { const j = (i + 1) % n; a += poly[i].x * poly[j].y - poly[j].x * poly[i].y; }
  return a / 2;
}
// return `ring` wound OPPOSITE to `outer` (required for the hole to subtract)
function orientOpposite(ring, outer) {
  return Math.sign(ringSignedArea(ring)) === Math.sign(ringSignedArea(outer)) ? ring.slice().reverse() : ring.slice();
}
// Stitch outer + each hole into one self-touching ring via the nearest vertex pair.
function buildKeyhole(outer, holes) {
  let ring = outer.slice();
  for (const hole of (holes || [])) {
    let bi = 0, bj = 0, bd = Infinity;
    for (let i = 0; i < ring.length; i++) for (let j = 0; j < hole.length; j++) {
      const d = Math.hypot(ring[i].x - hole[j].x, ring[i].y - hole[j].y);
      if (d < bd) { bd = d; bi = i; bj = j; }
    }
    // after outer vertex bi: enter the hole at bj, traverse it, close back to bj,
    // bridge back to bi, then resume the outer ring.
    const loop = hole.slice(bj).concat(hole.slice(0, bj));
    loop.push({ x: hole[bj].x, y: hole[bj].y }, { x: ring[bi].x, y: ring[bi].y });
    ring = ring.slice(0, bi + 1).concat(loop, ring.slice(bi + 1));
  }
  return ring;
}
// Perimeter that skips the zero-width bridges: outer + each hole ring on its own.
function areaPerimeterFt(m) {
  const s = state.scales[m.page] || 0;
  if (hasHoles(m)) return [m.outer, ...m.holes].reduce((sum, r) => sum + polygonPerimeterFt(r, s), 0);
  return polygonPerimeterFt(m.pts, s);
}
// The rings a user actually edits: the outer + each hole for a holed area, else the
// single ring. Handle indices (from handlePoints) map back through handleRef.
const editRings = m => hasHoles(m) ? [m.outer, ...m.holes] : [m.pts];
function handleRef(m, i) {
  for (const ring of editRings(m)) { if (i < ring.length) return { ring, vi: i, isHole: ring !== m.outer && ring !== m.pts }; i -= ring.length; }
  return null;
}
function nearestEdgeInRings(m, w, tol) {
  let best = null;
  for (const ring of editRings(m)) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const pr = projOnSeg(ring[i], ring[(i + 1) % n], w);
      if (pr.d <= tol && (!best || pr.d < best.d)) best = { ring, i, p: { x: pr.x, y: pr.y }, d: pr.d };
    }
  }
  return best;
}
// Add / remove a vertex on the correct ring, then rebuild the keyhole. Both fall
// back to the plain-ring primitives when the shape has no holes.
function insertHandle(m, w, tol) {
  if (!hasHoles(m)) { const e = nearestEdge(m, w, tol); if (e) { insertVertexAt(m, e); return true; } return false; }
  const e = nearestEdgeInRings(m, w, tol); if (!e) return false;
  const prev = snapshot();
  e.ring.splice(e.i + 1, 0, e.p);
  m.pts = buildKeyhole(m.outer, m.holes); m.modified = Date.now(); invalidateForKind(m);
  pushUndo(prev); markupsChanged(); setMsg('Point added.');
  return true;
}
function deleteHandle(m, hi) {
  if (!hasHoles(m)) { deleteVertexAt(m, hi); return; }
  const ref = handleRef(m, hi); if (!ref) return;
  const prev = snapshot();
  if (!ref.isHole) {
    if (m.outer.length <= 3) { setMsg('The outline needs at least 3 points.'); return; }
    m.outer.splice(ref.vi, 1);
  } else if (ref.ring.length <= 3) {
    m.holes = m.holes.filter(h => h !== ref.ring); // last removable vertex → drop the whole hole
  } else {
    ref.ring.splice(ref.vi, 1);
  }
  m.pts = buildKeyhole(m.outer, m.holes);
  const droppedHole = !hasHoles(m); // the last hole just collapsed
  normalizeHoles(m);
  m.modified = Date.now(); invalidateForKind(m);
  pushUndo(prev); markupsChanged(); setMsg(droppedHole ? 'Hole removed.' : 'Point removed.');
}

// ---- Box / Circle marquee regions. A region is { test(point)->bool, poly } so it
// can both catch vertices (Delete Points) and cut a hole (Delete Area).
function boxRegion(a, b) {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  return {
    test: p => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1,
    poly: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
  };
}
function circleRegion(c, r, seg = 16) {
  const poly = [];
  for (let i = 0; i < seg; i++) { const a = (i / seg) * Math.PI * 2; poly.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }); }
  return { test: p => Math.hypot(p.x - c.x, p.y - c.y) <= r, poly };
}
// Circle marquee: first click sets the center, second sets the radius.
function handleCircleClick(sel, w) {
  if (!circleCenter) {
    circleCenter = { x: w.x, y: w.y }; hoverW = { x: w.x, y: w.y };
    setMsg('Circle: click again to set the radius.'); vp.requestDraw(); return;
  }
  const c = circleCenter, r = Math.hypot(w.x - c.x, w.y - c.y);
  circleCenter = null; hoverW = null;
  if (r < 1e-6) { setMsg('Circle canceled.'); vp.requestDraw(); return; }
  applyRegionOp(sel, circleRegion(c, r));
  vp.requestDraw();
}
// Delete Area: cut the region out of a closed area as a keyhole hole. v1 requires
// the region to sit fully inside the outer ring (edge-crossing notches come later).
// When the last hole is gone, drop the metadata so the shape is a plain ring again
// (and a later hole cut reads the current outline, not a stale m.outer).
function normalizeHoles(m) { if (m.holes && m.holes.length === 0) { delete m.holes; delete m.outer; } }
// Markup/region → polygon-clipping geometry (Polygon = [outerRing, ...holeRings],
// each ring a closed array of [x,y]). Input winding doesn't matter to the library.
const ringXY = r => { const a = r.map(p => [p.x, p.y]); if (a.length) a.push([r[0].x, r[0].y]); return a; };
const markupPolygon = m => hasHoles(m) ? [ringXY(m.outer), ...m.holes.map(ringXY)] : [ringXY(m.pts)];
function ringToPts(ring) {
  const pts = ring.map(c => ({ x: c[0], y: c[1] }));
  if (pts.length > 1) { const f = pts[0], l = pts[pts.length - 1]; if (f.x === l.x && f.y === l.y) pts.pop(); }
  return pts;
}
const ringAreaPx = r => Math.abs(ringSignedArea(r));
const markupNetPx = m => hasHoles(m) ? ringAreaPx(m.outer) - m.holes.reduce((s, h) => s + ringAreaPx(h), 0) : ringAreaPx(m.pts);
// Write one result polygon ([outerPts, ...holePts]) onto a markup, keeping m.pts as
// the single keyhole ring every consumer reads.
function setMarkupGeom(target, poly) {
  const outer = poly[0], holes = poly.slice(1);
  if (holes.length) { target.outer = outer; target.holes = holes.map(h => orientOpposite(h, outer)); target.pts = buildKeyhole(target.outer, target.holes); }
  else { delete target.outer; delete target.holes; target.pts = outer; }
  target.modified = Date.now();
}
// Delete Area: subtract the Box/Circle region from a closed area via a robust
// polygon difference. Handles hole (region inside), notch (region crossing the
// edge), split (region slicing across → multiple pieces) and full removal alike.
function cutHole(m, region) {
  if (!CLOSED_KINDS.includes(m.kind)) { setMsg('Delete Area cuts from a closed area — not available on this shape.'); return; }
  let result;
  try { result = polygonClipping.difference(markupPolygon(m), [ringXY(region.poly)]); }
  catch (err) { setMsg('Couldn’t compute that cut — try a different box / circle.'); return; }
  const polys = (result || [])
    .map(poly => poly.map(ringToPts).filter(r => r.length >= 3))
    .filter(poly => poly.length && poly[0].length >= 3);
  const before = markupNetPx(m);
  const after = polys.reduce((s, poly) => s + ringAreaPx(poly[0]) - poly.slice(1).reduce((h, r) => h + ringAreaPx(r), 0), 0);
  if (polys.length && before - after < 1) { setMsg('The Box / Circle didn’t overlap this area.'); return; }
  const prev = snapshot();
  if (polys.length === 0) {
    const idx = state.markups.indexOf(m); if (idx >= 0) state.markups.splice(idx, 1);
    if (selectedId === m.id) selectedId = null;
    invalidateForKind(m); pushUndo(prev); markupsChanged(); setMsg('The whole area was removed.'); vp.requestDraw(); return;
  }
  setMarkupGeom(m, polys[0]);
  const clones = [];
  for (let i = 1; i < polys.length; i++) {
    const c = { ...JSON.parse(JSON.stringify(m)), id: randId(), created: Date.now() };
    delete c.outer; delete c.holes;
    setMarkupGeom(c, polys[i]);
    clones.push(c);
  }
  if (clones.length) { const idx = state.markups.indexOf(m); state.markups.splice(idx + 1, 0, ...clones); }
  invalidateForKind(m);
  pushUndo(prev); markupsChanged();
  const s = state.scales[m.page] || 0;
  const totalSf = s ? [m, ...clones].reduce((sum, x) => sum + polygonAreaFt2(x.pts, s), 0) : 0;
  setMsg(clones.length ? `Cut — area split into ${clones.length + 1} pieces${s ? ` (${fmt(totalSf, 0)} SF total)` : ''}.`
    : (s ? `Cut — area now ${fmt(polygonAreaFt2(m.pts, s), 0)} SF.` : 'Cut.'));
  vp.requestDraw();
}
function applyRegionOp(m, region) {
  if (editRegionOp === 'delarea') { cutHole(m, region); return; }
  const delWholeShape = () => {
    const prev = snapshot();
    const idx = state.markups.indexOf(m);
    if (idx >= 0) state.markups.splice(idx, 1);
    if (selectedId === m.id) selectedId = null;
    invalidateForKind(m);
    pushUndo(prev); markupsChanged(); setMsg('Whole shape was inside the selection — deleted.');
  };
  if (hasHoles(m)) {
    const outer = m.outer.filter(p => !region.test(p));
    if (outer.length < 3) { delWholeShape(); return; }
    const holes = m.holes.map(h => h.filter(p => !region.test(p))).filter(h => h.length >= 3);
    const removed = (m.outer.length - outer.length)
      + (m.holes.reduce((s, h) => s + h.length, 0) - holes.reduce((s, h) => s + h.length, 0));
    if (removed === 0) { setMsg('No points fell inside the selection.'); return; }
    const prev = snapshot();
    m.outer = outer; m.holes = holes; m.pts = buildKeyhole(m.outer, m.holes);
    normalizeHoles(m);
    m.modified = Date.now(); invalidateForKind(m);
    pushUndo(prev); markupsChanged(); setMsg(`Removed ${removed} point${removed === 1 ? '' : 's'}.`);
    return;
  }
  const keep = m.pts.filter(p => !region.test(p));
  const removed = m.pts.length - keep.length;
  if (removed === 0) { setMsg('No points fell inside the selection.'); return; }
  if (keep.length >= minPtsFor(m)) {
    const prev = snapshot();
    m.pts = keep; m.modified = Date.now(); invalidateForKind(m);
    pushUndo(prev); markupsChanged(); setMsg(`Removed ${removed} point${removed === 1 ? '' : 's'}.`);
  } else {
    delWholeShape();
  }
}
// Marquee overlay (world coords; drawn inside the page transform).
function drawMarquee(ctx) {
  const z = vp.view.zoom;
  ctx.save();
  ctx.strokeStyle = '#4da3ff'; ctx.setLineDash([5 / z, 4 / z]); ctx.lineWidth = 1.4 / z;
  ctx.fillStyle = 'rgba(77,163,255,.10)';
  if (drag && drag.mode === 'marquee-box') {
    const a = drag.from, b = drag.cur;
    ctx.beginPath();
    ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.fill(); ctx.stroke();
  } else if (circleCenter && hoverW) {
    const r = Math.hypot(hoverW.x - circleCenter.x, hoverW.y - circleCenter.y);
    ctx.beginPath(); ctx.arc(circleCenter.x, circleCenter.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

// Draw-time Join: a click (not a drag) on an earlier vertex of the live trace —
// not the start, the current end, or the point adjacent to the end — closes the
// shape with an edge to that vertex, keeping every point placed so far, then
// finishes. (Reposition still works: press-drag a vertex instead of clicking it.)
function tryDraftJoin(k) {
  if (!draft || POINT_KINDS.includes(draft.kind)) return;
  const last = draft.pts.length - 1;
  if (k === 0) {
    // Click the START to close the loop — the universal "join the ends" gesture,
    // and (besides Shift+Enter) the way to make a LINE takeoff a closed loop.
    // Lines finish open, so without this it felt like only areas could close.
    if (last < 2) return;                    // a loop needs at least 3 points
  } else {
    if (last < 3 || k >= last - 1) return;   // close to a mid-vertex; exclude the end + its neighbor
  }
  const prev = JSON.stringify(draft.pts);
  draft.pts.push({ x: draft.pts[k].x, y: draft.pts[k].y }); // closing edge to the clicked vertex
  draftRecord(prev);
  commitDraft();
}

// Shift+Enter while drafting: close the polyline (last point → first) before
// committing, so the drawn line finishes as a loop. No-op close for point-kinds
// or a too-short line; then commit as usual.
function closeDraftAndCommit() {
  if (draft && Array.isArray(draft.pts) && draft.pts.length >= 3 && !POINT_KINDS.includes(draft.kind)) {
    draft.pts.push({ x: draft.pts[0].x, y: draft.pts[0].y });
  }
  commitDraft();
}

function commitDraft() {
  if (!draft) return;
  const d = draft;
  draft = null; hoverW = null; draftDrag = null;
  const pts = d.pts;
  // double-click leaves two points on top of each other — drop the duplicate
  if (pts.length >= 2 &&
      dist(pts[pts.length - 1].x, pts[pts.length - 1].y, pts[pts.length - 2].x, pts[pts.length - 2].y) < 3 / vp.view.zoom) pts.pop();
  const min = CLOSED_KINDS.includes(d.kind) ? 3 : POINT_KINDS.includes(d.kind) ? 1 : 2;
  if (pts.length < min) { updateUndoButtons(); vp.requestDraw(); return; }
  // area takeoff: show the material form; create the markup only if confirmed
  if (d.kind === 'qarea') {
    const s = pageFtPerPx();
    askAreaConfig(polygonAreaFt2(pts, s), polygonPerimeterFt(pts, s), lastAreaCfg).then(cfg => {
      if (!cfg) { vp.requestDraw(); return; }
      rememberAreaCfg(cfg);
      state.markups.push({ id: randId(), page: state.page, kind: 'qarea', pts, cfg, created: Date.now() });
      pushUndo(d.prev);
      markupsChanged();
    });
    return;
  }
  // line takeoff: show the trench form; create the markup only if confirmed
  if (d.kind === 'qline') {
    askLineConfig(polyLengthFt(pts, pageFtPerPx()), lastLineCfg).then(cfg => {
      if (!cfg) { vp.requestDraw(); return; }
      lastLineCfg = cfg;
      state.markups.push({ id: randId(), page: state.page, kind: 'qline', pts, cfg, created: Date.now() });
      pushUndo(d.prev);
      markupsChanged();
    });
    return;
  }
  // count takeoff: name what was dropped; create the markup only if confirmed
  if (d.kind === 'qcount') {
    askCountConfig(pts.length, lastCountCfg).then(cfg => {
      if (!cfg) { vp.requestDraw(); return; }
      lastCountCfg = cfg;
      state.markups.push({ id: randId(), page: state.page, kind: 'qcount', color: curColor(), width: curWidth(), pts, cfg, created: Date.now() });
      pushUndo(d.prev);
      markupsChanged();
    });
    return;
  }
  const extra = {};
  if (d.kind === 'plane') extra.pitch = state.roofPitch;
  else if (d.kind === 'redge') { extra.etype = $('edgeType') ? $('edgeType').value : 'eave'; extra.pitch = state.roofPitch; }
  else if (d.kind === 'ritem') extra.itype = $('itemType') ? $('itemType').value : 'boot';
  else if (d.kind === 'contour' || d.kind === 'epad') extra.surface = curSurface;
  else if (d.kind === 'froom') extra.cfg = { ftype: curFloorType };
  else if (d.kind === 'ftrans') extra.cfg = { ttype: curTransType };
  else if (d.kind === 'fwall') extra.cfg = { size: curFramSize };
  else if (d.kind === 'fopening') extra.cfg = { otype: curFopenType, width: FOPEN_W[curFopenType] };
  else if (d.kind === 'fsheath') extra.cfg = { stype: curSheathType };
  else if (d.kind === 'escline') extra.cfg = { ltype: curEscLine };
  else if (d.kind === 'escitem') extra.cfg = { itype: curEscItem };
  else if (d.kind === 'escarea') extra.cfg = { atype: curEscArea };
  else if (d.kind === 'sstripe') extra.cfg = { stype: curStrpLine };
  else if (d.kind === 'sstall') extra.cfg = { ttype: curStrpStall };
  else if (d.kind === 'smark') extra.cfg = { mtype: curStrpMark };
  else if (d.kind === 'swall') extra.cfg = { mat: curSidMat };
  else if (d.kind === 'sopening') extra.cfg = { otype: curSidOpen, deductSF: SID_OPEN_DEDUCT[curSidOpen] };
  else if (d.kind === 'sgutter') extra.cfg = { gtype: curSidGut };
  else if (d.kind === 'sinsul') extra.cfg = { itype: curSidIns };
  else if (d.kind === 'dmarea') extra.cfg = { dtype: curDmArea };
  else if (d.kind === 'dmline') extra.cfg = { ltype: curDmLine };
  else if (d.kind === 'dmitem') extra.cfg = { itype: curDmItem };
  else if (d.kind === 'fnline') extra.cfg = { ftype: curFnLine };
  else if (d.kind === 'fngate') extra.cfg = { gtype: curFnGate };
  else if (d.kind === 'lsarea') extra.cfg = { atype: curLsArea };
  else if (d.kind === 'lsplant') extra.cfg = { ptype: curLsPlant };
  else if (d.kind === 'lsline') extra.cfg = { ltype: curLsLine };
  else if (d.kind === 'lshead') extra.cfg = { htype: curLsHead };
  else if (d.kind === 'dwall') { extra.height = state.drywall.wallHeight; extra.sides = curDwSides; }
  else if (d.kind === 'dceiling') extra.cfg = { ctype: curCeilType };
  else if (d.kind === 'dopening') extra.cfg = { otype: curDwOpening, deductSF: OPENING_DEDUCT[curDwOpening] };
  else if (d.kind === 'dtrim') extra.cfg = { ttype: curDwTrim };
  if (d.kind === 'ebound') state.markups = state.markups.filter(m => m.kind !== 'ebound'); // one boundary
  const finish = text => {
    state.markups.push({
      id: randId(), page: state.page, kind: d.kind, color: curColor(),
      width: curWidth(), pts, text, created: Date.now(), ...extra,
    });
    pushUndo(d.prev);
    markupsChanged();
    // the measurement is the ad: nudge base-tier users toward the takeoff layer
    if ((d.kind === 'marea' || d.kind === 'mlength') && !hasTakeoffLayer()) {
      const m = state.markups[state.markups.length - 1];
      setMsg(`${measureValue(m)} — turn measurements into a priced takeoff & bid: 🔒 Takeoff layer.`);
    }
    if (d.kind === 'plane') {
      modals.askNumber(`Roof plane pitch (rise per 12)`, 'e.g. 6 for 6/12. Sloped area & squares update live.', state.roofPitch, 1)
        .then(v => { if (v != null && v >= 0) { const m = state.markups[state.markups.length - 1]; if (m && m.kind === 'plane') { m.pitch = v; markupsChanged(); } } });
    } else if (d.kind === 'redge' && (extra.etype === 'rake' || extra.etype === 'hip' || extra.etype === 'valley')) {
      // Only rake/hip/valley are pitch-corrected (eave/ridge/flashing lie flat),
      // so only those ask. Defaults to the main pitch — Enter keeps it.
      modals.askNumber(`${EDGE_LABEL[extra.etype]} pitch (rise per 12)`, 'Slope correction for this edge — Enter keeps the main pitch.', state.roofPitch, 1)
        .then(v => { if (v != null && v >= 0) { const m = state.markups[state.markups.length - 1]; if (m && m.kind === 'redge') { m.pitch = v; markupsChanged(); } } });
    } else if (d.kind === 'contour' || d.kind === 'epad') {
      const surf = extra.surface;
      modals.askNumber(`${d.kind === 'contour' ? 'Contour' : 'Pad'} elevation (ft) — ${surf === 'existing' ? 'existing' : 'proposed'}`,
        'e.g. 812.5', d.kind === 'contour' ? nextElevDefault(surf) : (lastElev[surf] != null ? lastElev[surf] : ''), 1)
        .then(v => { if (v != null) { const m = state.markups[state.markups.length - 1]; if (m && (m.kind === 'contour' || m.kind === 'epad')) { m.elev = v; lastElev[surf] = v; markupsChanged(); } } });
    }
  };
  if (d.kind === 'mcount') modals.askText('What are you counting?', `${pts.length} clicked`, '').then(t => finish(t || 'items'));
  else if (d.kind === 'dheight') {
    const ft = polyLengthFt(pts, state.scales[state.page] || 0);
    modals.askText('Name this height', ft > 0 ? `Measured ${fmt(ft, 1)} ft — e.g. First floor, Great room, Garage` : 'No scale on this sheet — calibrate it with 📏 first', '')
      .then(t => finish((t && t.trim()) || (ft > 0 ? `${fmt(ft, 1)}′` : 'Height')));
  }
  else finish(undefined);
}

function cancelDraft() {
  draft = null; draftDrag = null; calibPts = null; hoverW = null;
  updateUndoButtons();
  vp.requestDraw();
}

// double-click: finish a measure draft, or edit a note's text
els.cv.addEventListener('dblclick', e => {
  if (!state.doc) return;
  if (extend) { extend = null; hoverW = null; setMsg('Finished.'); vp.requestDraw(); return; }
  if (draft) { commitDraft(); return; }
  const s = screenPt(e);
  const w = vp.screenToWorld(s.x, s.y);
  const hit = hitMarkup(vp.ctx, w);
  if (hit && (hit.kind === 'text' || hit.kind === 'callout')) {
    selectedId = hit.id;
    openOverlay({ mode: 'edit', markup: hit });
    return;
  }
  // double-click an area takeoff to re-open its material form
  if (hit && hit.kind === 'qarea') {
    selectedId = hit.id;
    vp.requestDraw();
    const s = state.scales[hit.page] || 0;
    askAreaConfig(polygonAreaFt2(hit.pts, s), areaPerimeterFt(hit), hit.cfg).then(cfg => {
      if (!cfg) return;
      const prev = snapshot();
      hit.cfg = cfg;
      rememberAreaCfg(cfg);
      pushUndo(prev);
      markupsChanged();
    });
    return;
  }
  // double-click an opening group to set its per-opening deduct SF
  if (hit && hit.kind === 'dopening') {
    selectedId = hit.id;
    vp.requestDraw();
    const c = hit.cfg || {};
    modals.askNumber(`${OPENING_LABEL[c.otype] || 'Opening'} deduct (SF each)`, 'SF subtracted from wall area per opening', c.deductSF != null ? c.deductSF : 15, 0)
      .then(v => { if (v != null && v >= 0) { const prev = snapshot(); hit.cfg = { ...c, deductSF: v }; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click a wall run to set its height (this run only) — pick a measured
  // elevation height if any exist, else type one
  if (hit && hit.kind === 'dwall') {
    selectedId = hit.id;
    vp.requestDraw();
    const applyH = v => { if (v != null && v > 0) { const prev = snapshot(); hit.height = v; pushUndo(prev); markupsChanged(); } };
    const askCustom = () => modals.askNumber('Wall height (ft) — this run', `Sides is ${hit.sides || 2} (toolbar toggle for new runs). Wall SF = length × height × sides.`, dwallHeight(hit), 1).then(applyH);
    const heights = state.markups.filter(m => m.kind === 'dheight');
    if (heights.length) {
      askChoice('Wall height — this run', 'Apply a height measured off an elevation sheet, or type one.', [
        ...heights.map(h => ({ label: `${h.text || 'Height'} — ${fmt(dheightFt(h), 1)} ft`, value: dheightFt(h) })),
        { label: 'Type a custom height…', value: '__custom' },
      ]).then(v => { if (v === '__custom') askCustom(); else if (v != null) applyH(v); });
    } else askCustom();
    return;
  }
  // double-click a measured height to rename it
  if (hit && hit.kind === 'dheight') {
    selectedId = hit.id;
    vp.requestDraw();
    modals.askText('Rename height', `${fmt(dheightFt(hit), 1)} ft measured`, hit.text || '')
      .then(t => { if (t != null && t.trim()) { const prev = snapshot(); hit.text = t.trim(); pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click a sheathing area to change its type
  if (hit && hit.kind === 'fsheath') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.stype) || 'osb716';
    askChoice('Sheathing type', 'Sheathing rolls up on the bid by type → 4×8 sheets.',
      ['osb716', 'ply12', 'ply58', 'zip'].map(k => ({ label: SHEATH_LABEL[k], value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), stype: v }; curSheathType = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click a framed opening group to set its rough-opening width
  if (hit && hit.kind === 'fopening') {
    selectedId = hit.id;
    vp.requestDraw();
    const c = hit.cfg || {};
    modals.askNumber(`${FOPEN_LABEL[c.otype] || 'Opening'} rough-opening width (ft)`, 'Drives the header LF and cripple count for each opening in this group.', c.width != null ? c.width : 3, 1)
      .then(v => { if (v != null && v > 0) { const prev = snapshot(); hit.cfg = { ...c, width: v }; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click a landscape area to change its type
  if (hit && hit.kind === 'lsarea') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.atype) || 'mulch';
    askChoice('Landscape type', 'Each type bids in its own material unit (CY, SY, ton, SF).',
      LS_AREA_KINDS.map(k => ({ label: `${LS_AREA_LABEL[k]} — by ${LS_AREA_UNIT[k]}`, value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), atype: v }; curLsArea = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click a plant group to change its type
  if (hit && hit.kind === 'lsplant') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.ptype) || 'shrub5';
    askChoice('Plant type', 'Plants roll up on the bid by type, at each type’s installed $/EA.',
      LS_PLANT_KINDS.map(k => ({ label: LS_PLANT_LABEL[k], value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), ptype: v }; curLsPlant = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click an irrigation run to change its type
  if (hit && hit.kind === 'lsline') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.ltype) || 'lateral';
    askChoice('Irrigation run type', 'Runs roll up on the bid by type, at each type’s installed $/LF.',
      LS_LINE_KINDS.map(k => ({ label: LS_LINE_LABEL[k], value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), ltype: v }; curLsLine = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click an irrigation head group to change its type
  if (hit && hit.kind === 'lshead') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.htype) || 'spray';
    askChoice('Head / device type', 'Devices roll up on the bid by type, at each type’s installed $/EA.',
      LS_HEAD_KINDS.map(k => ({ label: LS_HEAD_LABEL[k], value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), htype: v }; curLsHead = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click a fence run to change its type
  if (hit && hit.kind === 'fnline') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.ftype) || 'chain6';
    askChoice('Fence type', 'Each type carries its own post spacing, so the post count changes with it.',
      FN_LINE_KINDS.map(k => ({ label: `${FN_LINE_LABEL[k]} — posts @ ${FN_LINE_SPACING[k]}′`, value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), ftype: v }; curFnLine = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click a gate group to change its type
  if (hit && hit.kind === 'fngate') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.gtype) || 'walk';
    askChoice('Gate type', 'Gates roll up on the bid by type, at each type’s installed $/EA.',
      FN_GATE_KINDS.map(k => ({ label: FN_GATE_LABEL[k], value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), gtype: v }; curFnGate = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click a linear removal to change its type
  if (hit && hit.kind === 'dmline') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.ltype) || 'curb';
    askChoice('Removal type', 'Runs roll up on the bid by type, at each type’s installed $/LF.',
      DM_LINE_KINDS.map(k => ({ label: DM_LINE_LABEL[k], value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), ltype: v }; curDmLine = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click a demo item group to change its type
  if (hit && hit.kind === 'dmitem') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.itype) || 'tree';
    askChoice('Item type', 'Items roll up on the bid by type, at each type’s installed $/EA.',
      DM_ITEM_KINDS.map(k => ({ label: DM_ITEM_LABEL[k], value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), itype: v }; curDmItem = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click a demo area to change its type
  if (hit && hit.kind === 'dmarea') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.dtype) || 'bldgWood';
    askChoice('Demo type', 'Buildings convert by CY/SF; pavements by thickness × swell.',
      DM_AREA_KINDS.map(k => ({ label: DM_AREA_LABEL[k], value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), dtype: v }; curDmArea = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click a gutter run to change its type
  if (hit && hit.kind === 'sgutter') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.gtype) || 'k5';
    askChoice('Gutter type', 'Runs roll up on the bid by type, at each type’s installed $/LF.',
      SID_GUT_KINDS.map(k => ({ label: SID_GUT_LABEL[k], value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), gtype: v }; curSidGut = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click an insulation area to change its type
  if (hit && hit.kind === 'sinsul') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.itype) || 'battR13';
    askChoice('Insulation type', 'Areas roll up by type; batts also convert to bags.',
      SID_INS_KINDS.map(k => ({ label: SID_INS_LABEL[k], value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), itype: v }; curSidIns = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click a siding wall to change its material
  if (hit && hit.kind === 'swall') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.mat) || 'vinyl';
    askChoice('Siding material', 'Walls roll up on the bid by material.',
      SID_MAT_KINDS.map(k => ({ label: SID_MAT_LABEL[k], value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), mat: v }; curSidMat = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click a siding opening group to edit its deduct
  if (hit && hit.kind === 'sopening') {
    selectedId = hit.id;
    vp.requestDraw();
    const c = hit.cfg || {};
    modals.askNumber(`${SID_OPEN_LABEL[c.otype] || 'Opening'} deduct (SF each)`, 'Removed from the wall area for every opening in this group.', c.deductSF != null ? c.deductSF : 15, 0)
      .then(v => { if (v != null && v >= 0) { const prev = snapshot(); hit.cfg = { ...c, deductSF: v }; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click a marking / sign group to change its type
  if (hit && hit.kind === 'smark') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.mtype) || 'arrow';
    askChoice('Marking / sign type', 'Markings and signs roll up on the bid by type, at each type’s installed $/EA.',
      STRP_MARK_KINDS.map(k => ({ label: STRP_MARK_LABEL[k], value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), mtype: v }; curStrpMark = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click a stripe run to change its type
  if (hit && hit.kind === 'sstripe') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.stype) || 'line4';
    askChoice('Stripe type', 'Runs roll up on the bid by type, at each type’s installed $/LF.',
      STRP_LINE_KINDS.map(k => ({ label: STRP_LINE_LABEL[k], value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), stype: v }; curStrpLine = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click a stall group to change its type
  if (hit && hit.kind === 'sstall') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.ttype) || 'standard';
    askChoice('Stall type', 'Stalls roll up by type; ADA stalls are tallied separately.',
      STRP_STALL_KINDS.map(k => ({ label: STRP_STALL_LABEL[k], value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), ttype: v }; curStrpStall = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click an ESC stabilized area to change its type
  if (hit && hit.kind === 'escarea') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.atype) || 'entrance';
    askChoice('Area type', 'Each type drives its own material math (stone tons, SY, seed & mulch).',
      ESC_AREA_KINDS.map(k => ({ label: ESC_AREA_LABEL[k], value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), atype: v }; curEscArea = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click an ESC point BMP group to change its type
  if (hit && hit.kind === 'escitem') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.itype) || 'inletdrop';
    askChoice('BMP type', 'Point controls roll up on the bid by type, at each type’s installed $/EA.',
      ESC_ITEM_KINDS.map(k => ({ label: ESC_ITEM_LABEL[k], value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), itype: v }; curEscItem = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click an ESC control run to change its BMP type
  if (hit && hit.kind === 'escline') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.ltype) || 'silt';
    askChoice('Control type', 'Runs roll up on the bid by type, at each type’s installed $/LF.',
      ESC_LINE_KINDS.map(k => ({ label: ESC_LINE_LABEL[k], value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), ltype: v }; curEscLine = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click a framed wall to change its stud size
  if (hit && hit.kind === 'fwall') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.size) || '2x4';
    askChoice('Stud size', 'Walls roll up on the bid by stud size.',
      ['2x4', '2x6', '2x8'].map(k => ({ label: FRAM_SIZE_LABEL[k], value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), size: v }; curFramSize = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click a flooring transition to change its type
  if (hit && hit.kind === 'ftrans') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.ttype) || 'reducer';
    askChoice('Transition type', 'Transitions roll up on the bid by type → LF.',
      ['threshold', 'reducer', 'tmolding', 'stairnose', 'seam', 'other'].map(k => ({ label: TRANS_LABEL[k], value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), ttype: v }; curTransType = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click a floor room to change its material
  if (hit && hit.kind === 'froom') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.ftype) || 'tile';
    askChoice('Floor material', 'Rooms roll up on the bid by material.',
      ['tile', 'lvp', 'laminate', 'hardwood', 'carpet', 'vinyl', 'other'].map(k => ({ label: FLOOR_LABEL[k], value: k, primary: k === cur }))
    ).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), ftype: v }; curFloorType = v; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click a ceiling to change its type (drywall vs ACT drop-ceiling)
  if (hit && hit.kind === 'dceiling') {
    selectedId = hit.id;
    vp.requestDraw();
    const cur = (hit.cfg && hit.cfg.ctype) || 'drywall';
    askChoice('Ceiling type', 'Drywall ceilings add to the board & finish SF. ACT drop-ceilings are taken off as a suspended grid — tiles, main & cross tees, wall angle, and hanger wire.', [
      { label: 'Drywall', value: 'drywall', primary: cur === 'drywall' },
      { label: 'ACT 2×4 drop-ceiling', value: 'act24', primary: cur === 'act24' },
      { label: 'ACT 2×2 drop-ceiling', value: 'act22', primary: cur === 'act22' },
    ]).then(v => { if (v && v !== cur) { const prev = snapshot(); hit.cfg = { ...(hit.cfg || {}), ctype: v }; pushUndo(prev); markupsChanged(); } });
    return;
  }
  // double-click a count takeoff to rename it
  if (hit && hit.kind === 'qcount') {
    selectedId = hit.id;
    vp.requestDraw();
    askCountConfig(hit.pts.length, hit.cfg).then(cfg => {
      if (!cfg) return;
      const prev = snapshot();
      hit.cfg = cfg; lastCountCfg = cfg;
      pushUndo(prev);
      markupsChanged();
    });
    return;
  }
  // double-click a line takeoff to re-open its trench form
  if (hit && hit.kind === 'qline') {
    selectedId = hit.id;
    vp.requestDraw();
    askLineConfig(polyLengthFt(hit.pts, state.scales[hit.page] || 0), hit.cfg).then(cfg => {
      if (!cfg) return;
      const prev = snapshot();
      hit.cfg = cfg;
      lastLineCfg = cfg; lastLineColor = cfg.color;
      pushUndo(prev);
      markupsChanged();
    });
    return;
  }
  // double-click an earthwork markup to fix its elevation
  if (hit && (hit.kind === 'contour' || hit.kind === 'espot' || hit.kind === 'epad')) {
    selectedId = hit.id;
    vp.requestDraw();
    modals.askNumber(`${MK_LABEL[hit.kind]} elevation (ft) — ${hit.surface}`, 'e.g. 812.5', hit.elev != null ? hit.elev : '', 1)
      .then(v => {
        if (v == null) return;
        const prev = snapshot();
        hit.elev = v;
        lastElev[hit.surface] = v;
        pushUndo(prev);
        markupsChanged();
      });
  }
});

/* ============================== Text overlay ============================== */

let overlay = null; // {mode:'new-text'|'new-callout'|'edit', anchor?, markup?}
let overlayBusy = false;

function openOverlay(o) {
  cancelOverlay();
  overlay = o;
  const anchor = o.mode === 'new-text' ? o.anchor : o.markup.pts[0];
  const s = vp.worldToScreen(anchor.x, anchor.y);
  els.textOverlay.style.left = Math.max(4, s.x - 4) + 'px';
  els.textOverlay.style.top = Math.max(4, s.y - 4) + 'px';
  els.textOverlay.value = o.mode === 'edit' ? (o.markup.text || '') : '';
  els.textOverlay.classList.remove('hidden');
  els.textOverlay.focus();
}

function commitOverlay() {
  if (!overlay || overlayBusy) return;
  overlayBusy = true;
  const o = overlay;
  overlay = null;
  els.textOverlay.classList.add('hidden');
  const text = els.textOverlay.value.replace(/\s+$/, '');
  if (text.trim()) {
    const prev = snapshot();
    if (o.mode === 'new-text') {
      state.markups.push({
        id: randId(), page: state.page, kind: 'text', color: curColor(),
        width: curWidth(), fontSize: curFont(), pts: [o.anchor], text, created: Date.now(),
      });
    } else if (o.mode === 'new-callout') {
      o.markup.text = text;
      o.markup.fontSize = curFont();
      state.markups.push(o.markup);
    } else {
      o.markup.text = text;
      o.markup.modified = Date.now();
    }
    pushUndo(prev);
    markupsChanged();
  } else if (o.mode === 'edit') {
    vp.requestDraw(); // empty edit = leave unchanged
  }
  overlayBusy = false;
}

function cancelOverlay() {
  if (!overlay) return;
  overlay = null;
  els.textOverlay.classList.add('hidden');
  vp.requestDraw();
}

els.textOverlay.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitOverlay(); }
  if (e.key === 'Escape') { e.preventDefault(); cancelOverlay(); }
});
els.textOverlay.addEventListener('blur', () => commitOverlay());

/* ============================== Selected-markup restyling ============================== */

els.mkColor.addEventListener('input', () => {
  if (tool !== 'pan' && tool !== 'select') toolColors[tool] = els.mkColor.value;
  const m = selMarkup();
  if (m) {
    const prev = snapshot();
    m.color = els.mkColor.value;
    m.modified = Date.now();
    pushUndo(prev);
    markupsChanged();
  }
});
els.mkWidth.addEventListener('change', () => {
  const m = selMarkup();
  if (m) {
    const prev = snapshot();
    m.width = curWidth();
    if (m.fontSize) m.fontSize = curFont();
    m.modified = Date.now();
    pushUndo(prev);
    markupsChanged();
  }
});

function deleteSelected() {
  const m = selMarkup();
  if (!m) return;
  const prev = snapshot();
  state.markups = state.markups.filter(x => x.id !== m.id);
  selectedId = null;
  pushUndo(prev);
  markupsChanged();
}

/* ============================== Markup list panel ============================== */

$('btnList').addEventListener('click', () => {
  els.markupPanel.classList.toggle('hidden');
  if (!els.markupPanel.classList.contains('hidden')) { closeOtherPanels('markupPanel'); renderMarkupList(); }
  syncPanelButtons();
});
els.mkKindFilter.addEventListener('change', renderMarkupList);
els.mkThisSheet.addEventListener('change', renderMarkupList);

function renderMarkupList() {
  if (els.markupPanel.classList.contains('hidden')) return;
  const kind = els.mkKindFilter.value;
  const thisSheet = els.mkThisSheet.checked;
  const rows = state.markups
    .filter(m => (!kind || m.kind === kind) && (!thisSheet || m.page === state.page))
    .sort((a, b) => a.page - b.page || (a.created || 0) - (b.created || 0));
  els.mkList.innerHTML = '';
  if (!rows.length) {
    els.mkList.innerHTML = '<div class="mk-empty">No markups yet — pick a tool and drag on the sheet.</div>';
    return;
  }
  for (const m of rows) {
    const row = document.createElement('div');
    row.className = 'mk-row' + (m.id === selectedId ? ' selected' : '');
    row.innerHTML =
      `<span class="swatch" style="background:${esc(m.color)}"></span>` +
      `<span>${MK_ICON[m.kind] || '?'}</span>` +
      `<span class="grow"></span>` +
      `<span class="pg">p${m.page}</span>` +
      `<button class="btn tiny danger" title="Delete">✕</button>`;
    row.querySelector('.grow').textContent =
      (m.kind === 'mcount' || m.kind === 'ritem') ? measureValue(m)
      : (m.kind === 'mlength' || m.kind === 'marea' || m.kind === 'plane' || m.kind === 'redge') ? `${MK_LABEL[m.kind]} — ${measureValue(m)}`
      : m.text ? m.text.split('\n')[0] : MK_LABEL[m.kind];
    row.addEventListener('click', async e => {
      if (e.target.closest('button')) return;
      selectedId = m.id;
      await setPage(m.page);
      const ctx = vp.ctx;
      const bb = markupBBox(ctx, m);
      const r = els.cv.parentElement.getBoundingClientRect();
      vp.view.panX = r.width / 2 - ((bb.x0 + bb.x1) / 2) * vp.view.zoom;
      vp.view.panY = r.height / 2 - ((bb.y0 + bb.y1) / 2) * vp.view.zoom;
      renderMarkupList();
      vp.requestDraw();
    });
    row.querySelector('button').addEventListener('click', () => {
      const prev = snapshot();
      state.markups = state.markups.filter(x => x.id !== m.id);
      if (selectedId === m.id) selectedId = null;
      pushUndo(prev);
      markupsChanged();
    });
    els.mkList.appendChild(row);
  }
}

/* ============================== Roofing takeoff panel (takeoff layer) ============================== */

function renderRoofPanel() {
  const panel = $('roofPanel');
  if (!panel || panel.classList.contains('hidden')) return;
  const T = roofingTotals();
  const rows = [];
  rows.push(`<div class="roof-tot big"><span>Squares (with waste)</span><span class="v">${fmt(T.squaresWaste, 1)} sq</span></div>`);
  rows.push(`<div class="roof-tot"><span>Base squares</span><span class="v">${fmt(T.squares, 1)} sq</span></div>`);
  rows.push(`<div class="roof-tot"><span>Roof planes</span><span class="v">${T.planes}</span></div>`);
  if (T.scaleMissing) rows.push(`<div class="hint" style="margin:6px 0">Some sheets aren't calibrated (📏) — those planes/edges are excluded.</div>`);

  const edgeKeys = EDGE_TYPES.filter(k => T.edges[k]);
  if (edgeKeys.length) {
    rows.push('<div class="roof-sub">Edges (LF)</div>');
    for (const k of edgeKeys) rows.push(`<div class="roof-tot"><span>${EDGE_LABEL[k]}</span><span class="v">${fmt(T.edges[k], 0)} ft</span></div>`);
  }
  const itemKeys = ITEM_TYPES.filter(k => T.items[k]);
  if (itemKeys.length) {
    rows.push('<div class="roof-sub">Items (EA)</div>');
    for (const k of itemKeys) rows.push(`<div class="roof-tot"><span>${ITEM_LABEL[k]}</span><span class="v">${T.items[k]}</span></div>`);
  }
  if (!T.planes && !edgeKeys.length && !itemKeys.length) {
    rows.push('<div class="mk-empty">No roof takeoff yet — trace a plane (▰) and set its pitch, then add edges (╱) and items (⊕).</div>');
  }
  $('roofBody').innerHTML = rows.join('');
}

/* ============================== Roof Measurement report (roof add-on) ============================== */

// Same geometry as the roofing takeoff (roofingTotals / planeSquares / edgeFt),
// but the deliverable is a measurement report — the EagleView-style artifact —
// not a priced bid. Renders the on-screen panel AND the print-only branded block.
function renderRoofReport() {
  const panel = $('roofMeasPanel');
  const printing = document.body.classList.contains('printing-report');
  if ((!panel || panel.classList.contains('hidden')) && !printing) return;

  const T = roofingTotals();
  const facets = state.markups.filter(m => m.kind === 'plane');
  let html = '';
  html += `<div class="roof-tot big"><span>Total roof area (with ${fmt(state.roofWaste, 0)}% waste)</span><span class="v">${fmt(T.squaresWaste, 1)} sq</span></div>`;
  html += `<div class="roof-tot"><span>Base area</span><span class="v">${fmt(T.squares, 1)} sq · ${fmt(T.squares * 100, 0)} SF</span></div>`;
  html += `<div class="roof-tot"><span>Roof planes</span><span class="v">${T.planes}</span></div>`;
  if (T.scaleMissing) html += `<div class="hint" style="margin:6px 0">Some sheets aren't calibrated (📏) — those planes/edges are excluded. Set the scale on the aerial first.</div>`;

  if (facets.length) {
    html += '<div class="roof-sub">Roof planes</div>';
    html += '<table class="rr-table"><thead><tr><th>Plane</th><th>Plan SF</th><th>Pitch</th><th>Squares</th></tr></thead><tbody>';
    facets.forEach((m, i) => {
      const s = state.scales[m.page] || 0;
      const planSF = s ? polygonAreaFt2(m.pts, s) : 0;
      const sq = s ? planeSquares(m, s) : 0;
      html += `<tr><td>#${i + 1}</td><td class="v">${s ? fmt(planSF, 0) : '—'}</td><td>${fmt(m.pitch || 0, 0)}/12</td><td class="v">${s ? fmt(sq, 2) : '—'}</td></tr>`;
    });
    html += '</tbody></table>';
  }

  const edgeKeys = EDGE_TYPES.filter(k => T.edges[k]);
  if (edgeKeys.length) {
    html += '<div class="roof-sub">Edges (LF)</div><table class="rr-table"><tbody>';
    for (const k of edgeKeys) html += `<tr><td>${EDGE_LABEL[k]}</td><td class="v">${fmt(T.edges[k], 0)} ft</td></tr>`;
    html += '</tbody></table>';
  }

  const itemKeys = ITEM_TYPES.filter(k => T.items[k]);
  if (itemKeys.length) {
    html += '<div class="roof-sub">Penetrations (EA)</div><table class="rr-table"><tbody>';
    for (const k of itemKeys) html += `<tr><td>${ITEM_LABEL[k]}</td><td class="v">${T.items[k]}</td></tr>`;
    html += '</tbody></table>';
  }

  if (!facets.length && !edgeKeys.length && !itemKeys.length) {
    html += '<div class="mk-empty">No roof traced yet — set the scale (📏) on the aerial, trace each plane (▰) and set its pitch, then add edges (╱).</div>';
  }

  if ($('roofMeasBody')) $('roofMeasBody').innerHTML = html;

  // Mirror into the print-only branded block.
  const content = $('roofReportContent');
  if (content) {
    const co = loadBranding();
    const lh = $('roofReportLetterhead');
    if (lh) {
      const name = co.name ? `<div class="rr-co-name">${esc(co.name)}</div>` : '';
      const details = co.details ? `<div class="rr-co-details">${esc(co.details).replace(/\n/g, '<br>')}</div>` : '';
      lh.innerHTML = name + details;
    }
    const proj = (state.bidMeta && state.bidMeta.project) || state.projectName || '';
    const title = `<div class="rr-title">Roof Measurement Report</div><div class="rr-sub">${esc(proj)}${proj ? ' · ' : ''}${esc(new Date().toLocaleDateString())}</div>`;
    content.innerHTML = title + html;
  }
}

function printRoofReport() {
  document.body.classList.add('printing-report'); // set first so renderRoofReport populates the print block even if the panel is closed
  renderRoofReport();
  const done = () => { document.body.classList.remove('printing-report'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 1000); // Safari sometimes skips afterprint
}

function applyTakeoffGate() {
  document.body.classList.toggle('has-takeoff', hasTakeoffLayer());
  STORM_ON = hasStormAddon();
  document.body.classList.toggle('has-storm', STORM_ON); // hides the deep storm/utility fields when absent
  ROOF_ON = hasRoofAddon();
  document.body.classList.toggle('has-roof', ROOF_ON); // reveals the Roof Measurement mode + report
  // Roof draw tools show for a takeoff OR a roof owner (roof-only owners have no
  // takeoff layer but must still be able to trace). "can do roof work".
  document.body.classList.toggle('has-roofwork', hasTakeoffLayer() || ROOF_ON);
  // Door A (the roof-only entry button) shows for a roof owner without takeoff;
  // the dev override forces the roof-only view for a both-entitled (exempt) account.
  document.body.classList.toggle('roof-solo', roofSoloPreview());
}
let STORM_ON = false; // cached storm entitlement (refreshed in applyTakeoffGate); gates the M4 netting outputs
let ROOF_ON = false;  // cached roof-measurement entitlement (refreshed in applyTakeoffGate)

// Entitlements are bridged from the main app via localStorage (tc_addons) and can
// arrive or change AFTER this tool loads — a slow /auth/me on login, or an add-on
// bought in the other tab. Re-apply the gate when that key changes or the tab regains
// focus, so Takeoff doesn't stay falsely locked until a manual reload.
window.addEventListener('storage', e => {
  if (e.key === 'tc_addons' || e.key === null) applyTakeoffGate();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) applyTakeoffGate();
});

/* trade mode: which takeoff trade's tools/panels/bid are in play */
const TRADE_TOOLS = {
  roofing: ['plane', 'redge', 'ritem'],
  // Roof Measurement (roof add-on) reuses the roofing draw tools verbatim — its
  // difference from the roofing pack is the deliverable (a measurement report,
  // not a priced bid), not the tracing.
  roofmeas: ['plane', 'redge', 'ritem'],
  dirt: ['wand', 'contour', 'espot', 'epad', 'ebound', 'align', 'autoarea', 'qarea', 'qline', 'qcount'],
  drywall: ['dwall', 'dceiling', 'dopening', 'dtrim', 'dheight'],
  flooring: ['froom', 'ftrans'],
  framing: ['fwall', 'fopening', 'fsheath'],
  esc: ['escline', 'escitem', 'escarea'],
  striping: ['sstripe', 'sstall', 'smark'],
  siding: ['swall', 'sopening', 'sgutter', 'sinsul'],
  demo: ['dmarea', 'dmline', 'dmitem'],
  fence: ['fnline', 'fngate'],
  landscape: ['lsarea', 'lsplant', 'lsline', 'lshead'],
};
// general redlining + generic measure tools that collapse while a trade is active
const FOCUS_HIDDEN_TOOLS = ['cloud', 'rect', 'ellipse', 'arrow', 'line', 'freehand', 'highlight', 'text', 'callout', 'mlength', 'marea', 'mcount'];
// Every side panel — only one is ever open. Each toggle used to hard-code its
// own list of "the others", and the lists drifted as packs were added (opening
// Roof left Framing open, because btnRoof predates the framing pack). Derive it
// from one list so the next pack can't reintroduce that.
const PANEL_IDS = ['markupPanel', 'roofPanel', 'roofMeasPanel', 'dirtPanel', 'dwPanel', 'floorPanel', 'framPanel', 'escPanel', 'strpPanel', 'sidPanel', 'demPanel', 'fncPanel', 'lscPanel'];
function closeOtherPanels(keepId) {
  for (const id of PANEL_IDS) {
    if (id === keepId) continue;
    const p = $(id);
    if (p) p.classList.add('hidden');
  }
}
// Toolbar trade buttons show an 'active' state while their side panel is open.
function syncPanelButtons() {
  const mark = (btnId, panelId) => { const b = $(btnId), p = $(panelId); if (b && p) b.classList.toggle('active', !p.classList.contains('hidden')); };
  mark('btnRoof', 'roofPanel'); mark('btnRoofMeas', 'roofMeasPanel'); mark('btnDw', 'dwPanel'); mark('btnFloor', 'floorPanel'); mark('btnFram', 'framPanel'); mark('btnEsc', 'escPanel'); mark('btnStrp', 'strpPanel'); mark('btnSid', 'sidPanel'); mark('btnDem', 'demPanel'); mark('btnFnc', 'fncPanel'); mark('btnLsc', 'lscPanel');
  // Earthwork has no toolbar button — its panel is closed by the ✕ in its header
  // and reopened by the floating ⛰ button (top-right of the canvas), shown only
  // while in dirt mode with the panel closed.
  const openBtn = $('btnDirtOpen');
  if (openBtn) openBtn.classList.toggle('shown', state.trade === 'dirt' && $('dirtPanel').classList.contains('hidden'));
}
function setTrade(t, { save = true } = {}) {
  state.trade = t || '';
  document.body.classList.toggle('trade-active', !!state.trade);
  document.body.classList.toggle('trade-roofing', state.trade === 'roofing');
  document.body.classList.toggle('trade-roofmeas', state.trade === 'roofmeas');
  document.body.classList.toggle('trade-dirt', state.trade === 'dirt');
  document.body.classList.toggle('trade-drywall', state.trade === 'drywall');
  document.body.classList.toggle('trade-flooring', state.trade === 'flooring');
  document.body.classList.toggle('trade-framing', state.trade === 'framing');
  document.body.classList.toggle('trade-esc', state.trade === 'esc');
  document.body.classList.toggle('trade-striping', state.trade === 'striping');
  document.body.classList.toggle('trade-siding', state.trade === 'siding');
  document.body.classList.toggle('trade-demo', state.trade === 'demo');
  document.body.classList.toggle('trade-fence', state.trade === 'fence');
  document.body.classList.toggle('trade-landscape', state.trade === 'landscape');
  if ($('tradeSel')) $('tradeSel').value = state.trade;
  // drop a now-hidden tool + close the other trade's panel
  for (const [tr, tools] of Object.entries(TRADE_TOOLS)) {
    if (state.trade !== tr && tools.includes(tool)) setTool('pan');
  }
  if (state.trade && FOCUS_HIDDEN_TOOLS.includes(tool)) setTool('pan'); // annotation/measure collapse in trade focus
  // leaving a trade closes that trade's panel (markupPanel isn't trade-owned)
  const TRADE_PANEL = { roofing: 'roofPanel', roofmeas: 'roofMeasPanel', dirt: 'dirtPanel', drywall: 'dwPanel', flooring: 'floorPanel', framing: 'framPanel', esc: 'escPanel', striping: 'strpPanel', siding: 'sidPanel', demo: 'demPanel', fence: 'fncPanel', landscape: 'lscPanel' };
  for (const [tr, panelId] of Object.entries(TRADE_PANEL)) {
    if (state.trade !== tr) { const p = $(panelId); if (p) p.classList.add('hidden'); }
  }
  // Earthwork: open its side panel by default — on a user switch AND when a
  // project loads already in dirt mode. Collapse Sheets if the setup is done.
  if (state.trade === 'dirt') {
    closeOtherPanels('dirtPanel');
    $('dirtPanel').classList.remove('hidden');
    dirtSheetsCollapsed = dirtSetupComplete();
    renderDirtPanel();
    syncSurfaceToPage(); // refresh the surface toggle's gray/white/align state on entering dirt
  }
  // Roof Measurement: open the report panel by default — the report IS the point
  // of the mode.
  if (state.trade === 'roofmeas' && $('roofMeasPanel')) {
    closeOtherPanels('roofMeasPanel');
    $('roofMeasPanel').classList.remove('hidden');
    renderRoofReport();
  }
  syncPanelButtons();
  if (save) { // hints only on a user switch — not when a load restores the mode
    if (state.trade === 'roofing') setMsg('Roofing takeoff — trace planes (▰), edges (╱), items (⊕); totals in 🏠 Roof, prices in $ Bid.');
    else if (state.trade === 'roofmeas') setMsg('Roof Measurement — set the scale (📏) on the aerial, trace each roof plane (▰) and set its pitch, add edges (╱); the report is in 📐 Report.');
    else if (state.trade === 'dirt') setMsg('Earthwork takeoff — set the sheets in ⛰ Dirt, trace contours (⛰), align (⌖), then ∑ Calculate.');
    else if (state.trade === 'drywall') setMsg('Drywall & Paint — trace wall runs (▬) and ceilings (⬜); set the wall height in 🧱; prices in $ Bid.');
    else if (state.trade === 'flooring') setMsg('Flooring & Tile — trace each room (▦), set its material; net SF by material in 🟫, prices in $ Bid.');
    else if (state.trade === 'framing') setMsg('Framing & Lumber — trace wall runs (‖), set stud size; studs / plates / board-feet in 🪵, prices in $ Bid.');
    else if (state.trade === 'esc') setMsg('Erosion & Sediment Control — trace silt fence and the other perimeter controls (〰); LF by type in 🌱, prices in $ Bid.');
    else if (state.trade === 'striping') setMsg('Striping & Signage — count stalls (⊞), trace stop bars / crosswalks / lane lines (≡); totals in 🅿, prices in $ Bid.');
    else if (state.trade === 'siding') setMsg('Siding — trace each elevation (▥), click the openings (⊡) to deduct them; net SF & squares in ▥, prices in $ Bid.');
    else if (state.trade === 'demo') setMsg('Demolition — trace what comes out (▣); debris CY, tons & truck loads in 💥, prices in $ Bid.');
    else if (state.trade === 'fence') setMsg('Fencing — trace each run (⌗); LF + posts by type in 🚧, prices in $ Bid.');
    else if (state.trade === 'landscape') setMsg('Landscape — trace beds & sod (▢), count plants (❋), trace irrigation (≀) and drop heads (⊛); totals in 🌳, prices in $ Bid.');
    scheduleSave();
  }
}
function syncTradeUI() { setTrade(state.trade, { save: false }); }
if ($('tradeSel')) $('tradeSel').addEventListener('change', e => setTrade(e.target.value));

// push loaded roof settings into the inputs + refresh the panel
function syncRoofInputs() {
  if ($('roofPitch')) { $('roofPitch').value = state.roofPitch; $('roofWaste').value = state.roofWaste; }
  if ($('roofMeasPitch')) { $('roofMeasPitch').value = state.roofPitch; $('roofMeasWaste').value = state.roofWaste; }
  renderRoofPanel();
  renderRoofReport();
}

if ($('roofPitch')) {
  $('roofPitch').value = state.roofPitch;
  $('roofWaste').value = state.roofWaste;
  $('roofPitch').addEventListener('change', e => {
    state.roofPitch = Math.max(0, Math.min(24, parseFloat(e.target.value) || 0));
    e.target.value = state.roofPitch;
    scheduleSave(); renderRoofPanel(); renderMarkupList(); vp.requestDraw();
  });
  $('roofWaste').addEventListener('change', e => {
    state.roofWaste = Math.max(0, Math.min(40, parseFloat(e.target.value) || 0));
    e.target.value = state.roofWaste;
    scheduleSave(); renderRoofPanel();
  });
}
$('btnRoof').addEventListener('click', () => {
  $('roofPanel').classList.toggle('hidden');
  if (!$('roofPanel').classList.contains('hidden')) { closeOtherPanels('roofPanel'); renderRoofPanel(); }
  syncPanelButtons();
});

// Roof Measurement report panel: pitch/waste mirror the roofing state (shown in
// the report mode, where the roofing panel is closed), plus open/close/print.
if ($('roofMeasPitch')) {
  $('roofMeasPitch').value = state.roofPitch;
  $('roofMeasWaste').value = state.roofWaste;
  $('roofMeasPitch').addEventListener('change', e => {
    state.roofPitch = Math.max(0, Math.min(24, parseFloat(e.target.value) || 0));
    e.target.value = state.roofPitch;
    if ($('roofPitch')) $('roofPitch').value = state.roofPitch;
    scheduleSave(); renderRoofReport(); renderRoofPanel(); renderMarkupList(); vp.requestDraw();
  });
  $('roofMeasWaste').addEventListener('change', e => {
    state.roofWaste = Math.max(0, Math.min(40, parseFloat(e.target.value) || 0));
    e.target.value = state.roofWaste;
    if ($('roofWaste')) $('roofWaste').value = state.roofWaste;
    scheduleSave(); renderRoofReport(); renderRoofPanel();
  });
}
if ($('btnRoofMeas')) $('btnRoofMeas').addEventListener('click', () => {
  $('roofMeasPanel').classList.toggle('hidden');
  if (!$('roofMeasPanel').classList.contains('hidden')) { closeOtherPanels('roofMeasPanel'); renderRoofReport(); }
  syncPanelButtons();
});
// Door A — the alternate roof-only entry (shown only to a roof owner without
// takeoff, or under the ?roofsolo preview). Enters the roof-measurement mode.
if ($('btnRoofDoor')) $('btnRoofDoor').addEventListener('click', () => setTrade('roofmeas'));
if ($('btnRoofMeasClose')) $('btnRoofMeasClose').addEventListener('click', () => {
  $('roofMeasPanel').classList.add('hidden');
  syncPanelButtons();
});
if ($('roofMeasPrint')) $('roofMeasPrint').addEventListener('click', printRoofReport);
$('btnUpsell').addEventListener('click', () => {
  setMsg('Takeoff layer ($60/mo add-on): turn your measurements into roofing squares, pitch-corrected edges, materials, and a priced, branded bid. Add it from Billing.');
});

/* ---- bid letterhead / branding (company info persists across all projects
 *      in localStorage; per-bid project/prepared/date persist with the project) ---- */
let brandingCache = null;
function loadBranding() {
  if (brandingCache) return brandingCache;
  try { brandingCache = JSON.parse(localStorage.getItem('planroom-branding') || '{}') || {}; }
  catch (_) { brandingCache = {}; }
  return brandingCache;
}
function saveBranding(b) {
  brandingCache = b;
  try { localStorage.setItem('planroom-branding', JSON.stringify(b)); }
  catch (_) { setMsg('Could not save the letterhead — storage is full. Try a smaller logo.'); }
}
function renderLetterhead() {
  const co = loadBranding();
  const img = $('bidLogoImg');
  if (co.logo) { img.src = co.logo; img.hidden = false; } else { img.removeAttribute('src'); img.hidden = true; }
  $('bidLogoRemove').hidden = !co.logo;
  const name = co.name ? `<div class="bid-co-name">${esc(co.name)}</div>` : '';
  const details = co.details ? `<div class="bid-co-details">${esc(co.details).replace(/\n/g, '<br>')}</div>` : '';
  $('bidCompanyRender').innerHTML = name + details;
  $('bidLetterhead').hidden = !(co.logo || co.name || co.details);
}
const fileToDataURL = file => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
// cap the logo so it prints crisp and doesn't blow the localStorage quota
function downscaleImage(dataUrl, maxW, maxH) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width, maxH / img.height);
      const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      try { resolve(c.toDataURL('image/png')); } catch (_) { resolve(dataUrl); }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
$('bidCompanyName').addEventListener('input', e => { const co = loadBranding(); co.name = e.target.value; saveBranding(co); renderLetterhead(); });
$('bidCompanyDetails').addEventListener('input', e => { const co = loadBranding(); co.details = e.target.value; saveBranding(co); renderLetterhead(); });
$('bidLogoFile').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { const scaled = await downscaleImage(await fileToDataURL(f), 440, 128); const co = loadBranding(); co.logo = scaled; saveBranding(co); renderLetterhead(); }
  catch (_) { setMsg('Could not read that image.'); }
});
$('bidLogoRemove').addEventListener('click', () => { const co = loadBranding(); co.logo = ''; saveBranding(co); renderLetterhead(); });
['bidProject', 'bidPrep', 'bidDate'].forEach(id => $(id).addEventListener('input', () => {
  state.bidMeta = { project: $('bidProject').value, prep: $('bidPrep').value, date: $('bidDate').value };
  scheduleSave();
}));

/* ---- roofing bid ---- */
function renderRoofBid() {
  const { lines, subtotal, op, total } = roofBidLines();
  const head = '<thead><tr><th>Item</th><th class="num">Qty</th><th>Unit</th><th class="num">Unit price</th><th class="num">Extended</th></tr></thead>';
  const body = lines.map(l =>
    `<tr>
      <td>${esc(l.label)}</td>
      <td class="num">${fmt(l.qty, l.q || 0)}</td>
      <td>${l.unit}</td>
      <td class="num"><input class="price" type="number" min="0" step="0.01" data-key="${l.key}" value="${l.price}"></td>
      <td class="num">${money(l.ext)}</td>
    </tr>`).join('');
  const emptyMsg =
    state.trade === 'dirt' ? 'No earthwork volumes yet — run ∑ Calculate in the ⛰ Dirt panel first.'
    : state.trade === 'roofing' ? 'No roofing takeoff yet — trace planes (▰), edges (╱), and items (⊕).'
    : state.trade === 'drywall' ? 'No drywall takeoff yet — trace wall runs (▬) and ceilings (⬜).'
    : state.trade === 'flooring' ? 'No flooring takeoff yet — trace each room (▦) and set its material.'
    : state.trade === 'framing' ? 'No framing takeoff yet — trace wall runs (‖) and set the stud size.'
    : state.trade === 'esc' ? 'No erosion-control takeoff yet — trace a control run (〰) and set its type.'
    : state.trade === 'striping' ? 'No striping takeoff yet — count stalls (⊞) or trace a stripe run (≡).'
    : state.trade === 'siding' ? 'No siding takeoff yet — trace an elevation (▥) and set its material.'
    : state.trade === 'demo' ? 'No demolition takeoff yet — trace an area (▣) and set its type.'
    : state.trade === 'fence' ? 'No fencing takeoff yet — trace a run (⌗) and set its type.'
    : state.trade === 'landscape' ? 'No landscape takeoff yet — trace an area (▢) or count plants (❋).'
    : 'No takeoff yet — pick a trade in the toolbar dropdown, or trace a takeoff and come back.';
  $('bidTable').innerHTML = head + '<tbody>' + (lines.length ? body : `<tr><td colspan="5" class="mk-empty">${emptyMsg}</td></tr>`) + '</tbody>';
  $('bidTotals').innerHTML =
    `Subtotal: <b>${money(subtotal)}</b><br>` +
    `Overhead &amp; profit (${fmt(state.roofOP)}%): <b>${money(op)}</b><br>` +
    `<span class="grand">Total: ${money(total)}</span>`;
  $('bidTable').querySelectorAll('input.price').forEach(inp => {
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      state.roofPrices[inp.dataset.key] = isNaN(v) ? 0 : v;
      scheduleSave();
      renderRoofBid();
    });
  });
}

// The "Send pricing to estimate" button appears only when a takeoff is linked
// to an estimate (via the $ Bid dropdown, or a ?estimate= launch).
function syncBidSendBtn() {
  const sendBtn = $('bidSendEstimate');
  if (!sendBtn) return;
  if (state.estimateId) { sendBtn.textContent = `➤ Send pricing to estimate #${state.estimateId}`; sendBtn.classList.remove('hidden'); }
  else sendBtn.classList.add('hidden');
}
// Populate the $ Bid "Estimate" dropdown from the company's DRAFT estimates
// (only drafts can receive pricing) and pre-select the current link.
async function populateBidEstimates() {
  const sel = $('bidEstimate'), hint = $('bidEstimateHint');
  if (!sel) return;
  sel.innerHTML = '<option value="">— not linked —</option>';
  if (!toolToken()) { sel.disabled = true; if (hint) hint.textContent = 'Sign in to OpsFloa to link an estimate.'; return; }
  sel.disabled = false;
  try {
    const r = await apiEstimate('?status=draft&limit=100', { timeout: 12000 });
    if (!r.ok) {
      sel.disabled = true;
      if (hint) hint.textContent = r.status === 401 ? 'Session expired — reopen Plan Room from OpsFloa.' : `Couldn’t load estimates (HTTP ${r.status}).`;
      return;
    }
    const items = (await r.json()).items || [];
    for (const e of items) {
      const opt = document.createElement('option');
      opt.value = e.id;
      const who = e.client_name_snapshot || e.project_name || '';
      opt.textContent = `#${e.id}${who ? ' · ' + who : ''}`;
      sel.appendChild(opt);
    }
    // keep the current link selectable even if it isn't a draft in the list
    if (state.estimateId && !items.some(e => String(e.id) === String(state.estimateId))) {
      const opt = document.createElement('option');
      opt.value = state.estimateId; opt.textContent = `#${state.estimateId} (linked)`;
      sel.appendChild(opt);
    }
    sel.value = state.estimateId || '';
    if (hint) hint.textContent = state.estimateId ? 'Send puts this bid’s line items on the estimate.'
      : items.length ? 'Pick an estimate to send this bid’s pricing to it.'
      : 'No draft estimates yet — create one in OpsFloa.';
  } catch (_) { if (hint) hint.textContent = 'Could not load estimates.'; }
}

function openRoofBid() {
  $('bidTitle').textContent =
    state.trade === 'roofing' ? '🏠 Roofing bid'
    : state.trade === 'dirt' ? '⛰ Earthwork bid'
    : state.trade === 'drywall' ? '🧱 Drywall & Paint bid'
    : state.trade === 'flooring' ? '▦ Flooring & Tile bid'
    : state.trade === 'framing' ? '🪵 Framing & Lumber bid'
    : state.trade === 'esc' ? '🌱 Erosion & Sediment Control bid'
    : state.trade === 'striping' ? '🅿 Striping & Signage bid'
    : state.trade === 'siding' ? '▥ Siding, Gutters & Insulation bid'
    : state.trade === 'demo' ? '💥 Demolition bid'
    : state.trade === 'fence' ? '🚧 Fencing & Guardrail bid'
    : state.trade === 'landscape' ? '🌳 Landscape & Irrigation bid'
    : '$ Takeoff bid';
  const co = loadBranding();
  $('bidCompanyName').value = co.name || '';
  $('bidCompanyDetails').value = co.details || '';
  renderLetterhead();
  const meta = state.bidMeta || {};
  $('bidProject').value = meta.project || state.projectName || '';
  $('bidPrep').value = meta.prep || co.name || '';
  $('bidDate').value = meta.date || new Date().toLocaleDateString();
  $('bidOP').value = state.roofOP;
  syncBidSendBtn();
  populateBidEstimates();
  renderRoofBid();
  $('roofBid').classList.remove('hidden');
}

function printRoofBid() {
  document.body.classList.add('printing-bid');
  const done = () => { document.body.classList.remove('printing-bid'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 1000); // Safari sometimes skips afterprint
}

function bidCsv() {
  const { lines, subtotal, op, total } = roofBidLines();
  const qc = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const co = loadBranding(), meta = state.bidMeta || {};
  const rows = [];
  if (co.name) rows.push(qc(co.name));
  rows.push([qc('Project'), qc(meta.project || state.projectName || '')].join(','));
  rows.push([qc('Prepared by'), qc(meta.prep || co.name || '')].join(','));
  rows.push([qc('Date'), qc(meta.date || new Date().toLocaleDateString())].join(','));
  rows.push('');
  rows.push(['Item', 'Qty', 'Unit', 'Unit price', 'Extended'].map(qc).join(','));
  for (const l of lines) rows.push([l.label, fmt(l.qty, l.q || 0), l.unit, l.price, l.ext.toFixed(2)].map(qc).join(','));
  rows.push('');
  rows.push([qc('Subtotal'), '', '', '', qc(subtotal.toFixed(2))].join(','));
  rows.push([qc(`Overhead & profit ${fmt(state.roofOP)}%`), '', '', '', qc(op.toFixed(2))].join(','));
  rows.push([qc('Total'), '', '', '', qc(total.toFixed(2))].join(','));
  download(new Blob([rows.join('\r\n')], { type: 'text/csv' }), safeName() + '-takeoff-bid.csv');
}

// Map a bid line to one of the estimate's MONEY_CATEGORIES
// (labor|materials|equipment|subs|overhead|contingency|other). Best-effort by
// keyword — she can recategorize any line in the estimate.
function estimateCategoryFor(l) {
  const s = ((l.key || '') + ' ' + (l.label || '')).toLowerCase();
  if (/haul|excavat|export|import|earthwork|fill|backfill|grad|dozer|loader/.test(s)) return 'equipment';
  if (/\bhang\b|install|tear-?off|finish|labor|demo|disposal|prep/.test(s)) return 'labor';
  if (/board|shingle|concrete|mud|paint|sheet|paver|asphalt|compound|underlay|drip|starter|\bice\b|cap|flash|tape|base|crown|chair|trim|material/.test(s)) return 'materials';
  return 'other';
}

// Push the takeoff's priced lines back to the linked OpsFloa estimate
// (PUT /estimates/:id/lines — bulk replace, draft only, admin only). The O&P %
// rides along as one overhead line so the estimate total matches the bid.
async function sendPricingToEstimate() {
  const id = state.estimateId;
  if (!id) return;
  if (!toolToken()) { setMsg('Sign in to OpsFloa first (open ☁ Company / join live), then try again.'); return; }
  const { lines, op } = roofBidLines();
  const payload = lines.map(l => ({
    category: estimateCategoryFor(l),
    description: l.label,
    qty: Math.round((l.qty || 0) * 100) / 100,
    unit: (l.unit || '').toString().slice(0, 20) || null,
    unit_cost_cents: Math.round((l.price || 0) * 100),
  }));
  if (Number(state.roofOP) > 0 && op > 0) {
    payload.push({ category: 'overhead', description: `Overhead & profit (${fmt(state.roofOP)}%)`, qty: 1, unit: 'LS', unit_cost_cents: Math.round(op * 100) });
  }
  if (!payload.length) { setMsg('Nothing to send yet — trace a takeoff and price it first.'); return; }
  if (!window.confirm(`Send ${payload.length} line${payload.length === 1 ? '' : 's'} to estimate #${id}?\n\nThis REPLACES the estimate's current line items.`)) return;
  const btn = $('bidSendEstimate'); const prev = btn.textContent; btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const r = await apiEstimate('/' + encodeURIComponent(id) + '/lines', { method: 'PUT', body: JSON.stringify({ lines: payload }), timeout: 20000 });
    if (r.ok) {
      setMsg(`Sent ${payload.length} line${payload.length === 1 ? '' : 's'} to estimate #${id}. Review and send the bid in OpsFloa.`);
    } else if (r.status === 409) {
      setMsg(`Estimate #${id} is locked (already sent/accepted). Duplicate it in OpsFloa to revise.`);
    } else if (r.status === 404) {
      setMsg(`Estimate #${id} wasn't found — it may have been deleted.`);
    } else if (r.status === 401 || r.status === 403) {
      setMsg(`Not allowed to edit estimate #${id} — admin access is required in OpsFloa.`);
    } else {
      let msg = ''; try { msg = (await r.json()).error; } catch (_) {}
      setMsg(`Couldn't send pricing (HTTP ${r.status}${msg ? ': ' + msg : ''}).`);
    }
  } catch (_) {
    setMsg('Couldn’t reach OpsFloa to send pricing. Check your connection and try again.');
  } finally { btn.disabled = false; btn.textContent = prev; }
}

$('btnBid').addEventListener('click', openRoofBid);
$('bidSendEstimate').addEventListener('click', sendPricingToEstimate);
if ($('bidEstimate')) $('bidEstimate').addEventListener('change', e => {
  state.estimateId = e.target.value || null;
  scheduleSave();
  syncBidSendBtn();
  const hint = $('bidEstimateHint');
  if (hint) hint.textContent = state.estimateId ? 'Send puts this bid’s line items on the estimate.' : 'Not linked — pick an estimate to send this bid’s pricing.';
});
$('bidClose').addEventListener('click', () => $('roofBid').classList.add('hidden'));
$('roofBid').addEventListener('click', e => { if (e.target === $('roofBid')) $('roofBid').classList.add('hidden'); });
$('bidOP').addEventListener('input', e => {
  state.roofOP = Math.max(0, Math.min(100, parseFloat(e.target.value) || 0));
  scheduleSave();
  renderRoofBid();
});
$('bidPrint').addEventListener('click', printRoofBid);
$('bidCsv').addEventListener('click', bidCsv);

/* ---- earthwork (sitework pack, S1: trace + designate; compute = next slice) ---- */
const alignIsSet = () => { const a = state.earthwork.align; return !(a.a === 1 && a.b === 0 && a.e === 0 && a.f === 0); };
// The two-sheet setup is "done" once both sheets are designated and — when they
// differ — the alignment is solved. Drives collapsing the Sheets section.
function dirtSetupComplete() {
  const E = state.earthwork;
  if (!E.existingPage || !E.proposedPage) return false;
  if (E.existingPage === E.proposedPage) return true; // single sheet — no alignment needed
  return alignIsSet();
}

// The section- and subgroup-visibility keys a listable shape belongs to, matching
// the panel's grouping. Used by both markupShown (what draws) and the eye icons
// (what the header toggles). Returns null for anything that isn't a dirt shape.
function shapeVisKeys(m) {
  if (m.kind === 'contour' || m.kind === 'espot' || m.kind === 'epad') {
    return { section: `sec:contours:${m.surface || 'existing'}`, group: `c:${m.surface || 'existing'}:${m.kind}` };
  }
  if (m.kind === 'qarea' || m.kind === 'qline' || m.kind === 'qcount') {
    const color = m.kind === 'qline' ? lineColorHex(m.cfg || {}) : m.kind === 'qarea' ? areaColorHex(m.cfg || {}) : (m.color || '#e0533f');
    return { section: 'sec:takeoffs', group: `t:${m.kind}:${takeoffGroupLabel(m.kind, m)}:${color}` };
  }
  return null;
}

// The map-visibility eye for a header/subheader. Shown (white) = draws on the
// plan; hidden (dark gray) = doesn't. Its own clickable element so it doesn't
// also toggle the header's collapse (the handler stops propagation).
const EYE_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M12 5C6.5 5 2.7 8.6 1 12c1.7 3.4 5.5 7 11 7s9.3-3.6 11-7c-1.7-3.4-5.5-7-11-7zm0 11.5A4.5 4.5 0 1 1 12 7a4.5 4.5 0 0 1 0 9.5zM12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>';
function dirtEye(vkey) {
  const hidden = dirtHidden.has(vkey);
  return `<span class="dirt-eye${hidden ? ' off' : ''}" data-act="toggle-vis" data-vkey="${encodeURIComponent(vkey)}" ` +
    `title="${hidden ? 'Hidden on the plan — click to show' : 'Shown on the plan — click to hide'}">${EYE_SVG}</span>`;
}

// A collapsible subgroup header for the dirt panel's shape lists — an eye, a color
// swatch (optional), a bold label + count, and a ▾/▸ chevron. `gkey` is a stable
// key tracked in dirtGroupsCollapsed (fold) and dirtHidden (map visibility).
function dirtGroupHeader(gkey, label, count, color) {
  const collapsed = dirtGroupsCollapsed.has(gkey);
  const sw = color ? `<span class="ctr-sw" style="background:${color}"></span>` : '';
  // gkey can carry material names with quotes (e.g. `18" hdpe`); URI-encode it so
  // it's always attribute-safe (decoded back in the toggle handler).
  return `<div class="dirt-grp" data-act="toggle-group" data-gkey="${encodeURIComponent(gkey)}">` +
    `${sw}<span class="dirt-grp-lbl"><b>${esc(label)}</b> (${count})</span>` +
    `${dirtEye(gkey)}<span class="v">${collapsed ? '▸' : '▾'}</span></div>`;
}
// The type/material label a takeoff groups under (mirrors takeoffSubtotals so the
// group headers and the Σ subtotals line up).
function takeoffGroupLabel(kind, m) {
  const cfg = m.cfg || {};
  if (kind === 'qline') return pipeScheduleLabel(cfg);
  return cfg.label || (kind === 'qcount' ? 'Item' : 'Area');
}

function renderDirtPanel() {
  const panel = $('dirtPanel');
  if (!panel || panel.classList.contains('hidden')) return;
  const E = state.earthwork;
  const c = earthworkCounts();
  const rows = [];
  // Sheets — collapsible; collapses by default once the setup is complete
  const setupDone = dirtSetupComplete();
  rows.push(`<div class="roof-sub dirt-collapse" data-act="toggle-sheets"><span>Sheets${setupDone ? ' ✓' : ''}</span><span class="v">${dirtSheetsCollapsed ? '▸' : '▾'}</span></div>`);
  if (!dirtSheetsCollapsed) {
    rows.push(`<div class="dirt-row"><span>Existing sheet</span><span class="v">${E.existingPage ? 'page ' + E.existingPage : '—'}</span></div>`);
    rows.push(`<button class="btn tiny dirt-btn" data-act="set-existing">Set current page (${state.page}) as Existing</button>`);
    rows.push(`<div class="dirt-row"><span>Proposed sheet</span><span class="v">${E.proposedPage ? 'page ' + E.proposedPage : '—'}</span></div>`);
    rows.push(`<button class="btn tiny dirt-btn" data-act="set-proposed">Set current page (${state.page}) as Proposed</button>`);
    const alignVal = (E.existingPage && E.proposedPage && E.existingPage === E.proposedPage)
      ? 'n/a (same sheet)'
      : alignIsSet()
        ? 'set · <a class="dirt-link" data-act="do-align">re-align</a>'
        : '<a class="dirt-link" data-act="do-align">not set — align</a>';
    rows.push(`<div class="dirt-row"><span>Alignment</span><span class="v">${alignVal}</span></div>`);
    rows.push(`<label class="dirt-row" style="cursor:pointer"><span>Ghost the other sheet</span><input type="checkbox" id="ghostChk" ${ghostOn ? 'checked' : ''}></label>`);
  }

  // Controls whether the shape lists below list every page's markups or just this
  // page's (a LIST filter — the plan still draws the current page). The eye on each
  // header/subheader is separate: it hides that group on the plan itself.
  const onPage = m => dirtShowAllPages || m.page === state.page;
  const pageTag = m => (dirtShowAllPages && m.page !== state.page) ? ` · p${m.page}` : '';
  rows.push(`<label class="dirt-row dirt-allpages" style="cursor:pointer"><span>Show markups from all pages</span><input type="checkbox" id="showAllPagesChk" ${dirtShowAllPages ? 'checked' : ''}></label>`);

  // Contours — the focused surface's traced lines/spots/pads (current page, or all
  // pages when the checkbox is on), split into collapsible Contours / Spots / Pads
  // subgroups (sorted by elevation), color swatch, edit ✎ / delete ✕, eye = hide
  // on plan, click a row to select & jump.
  const surfLabel = curSurface === 'proposed' ? 'Proposed' : 'Existing';
  const surfItems = state.markups
    .filter(m => (m.kind === 'contour' || m.kind === 'espot' || m.kind === 'epad') && (m.surface || 'existing') === curSurface && onPage(m))
    .sort((a, b) => (b.elev == null ? -1e9 : b.elev) - (a.elev == null ? -1e9 : a.elev));
  rows.push(`<div class="roof-sub dirt-collapse" data-act="toggle-contours"><span>${surfLabel} contours (${surfItems.length})</span><span class="dirt-hd-r">${dirtEye('sec:contours:' + curSurface)}<span class="v">${dirtContoursCollapsed ? '▸' : '▾'}</span></span></div>`);
  if (!dirtContoursCollapsed) {
    rows.push(`<div class="dirt-crow"><span class="hint">New traces are <b>${curSurface}</b> · dashed = existing, solid = proposed${dirtShowAllPages ? '' : ' · this page only'}</span>${surfItems.length ? '<button class="ctr-clear" data-act="clear-surface" title="Delete all traces on this surface">Clear</button>' : ''}</div>`);
    if (!surfItems.length) {
      rows.push('<div class="hint" style="margin:2px 0 8px">No traces on this page yet — trace a contour (⛰), spot (◎), or pad (◫).</div>');
    } else {
      const ctrGroups = [{ kind: 'contour', label: 'Contours' }, { kind: 'espot', label: 'Spots' }, { kind: 'epad', label: 'Pads' }]
        .map(g => ({ ...g, items: surfItems.filter(m => m.kind === g.kind) }))
        .filter(g => g.items.length);
      // Only one type present → skip the subheader (it would just echo the
      // section header above). Two+ types → collapsible per-type subgroups.
      const flat = ctrGroups.length <= 1;
      // Flat = no subgroup eye, so the section eye governs; drop any stale hidden
      // key for the lone group (else it could be stuck hidden with no way back).
      if (flat && ctrGroups[0]) dirtHidden.delete(`c:${curSurface}:${ctrGroups[0].kind}`);
      for (const g of ctrGroups) {
        const gkey = `c:${curSurface}:${g.kind}`;
        if (!flat) {
          rows.push(dirtGroupHeader(gkey, g.label, g.items.length, null));
          if (dirtGroupsCollapsed.has(gkey)) continue;
        }
        for (const m of g.items) {
          const typ = m.kind === 'espot' ? 'spot' : m.kind === 'epad' ? 'flat pad' : `${m.pts.length} pts`;
          rows.push(`<div class="ctr-row${m.id === selectedId ? ' sel' : ''}" data-id="${m.id}">` +
            `<span class="ctr-sw" style="background:${elevColor(m.elev || 0, m.surface)}"></span>` +
            `<span class="ctr-lbl">${m.elev != null ? elevStr(m.elev) + ' ft' : 'no elev'} · ${typ}${pageTag(m)}</span>` +
            `<button class="ctr-btn" data-act="edit-elev" title="Edit elevation">✎</button>` +
            `<button class="ctr-btn" data-act="del-ctr" title="Delete">✕</button>` +
            `</div>`);
        }
      }
    }
  }
  // Takeoff quantities — area / line / count. These price into the $ Bid and are
  // SEPARATE from the cut/fill grade surface above: they carry no existing/proposed
  // surface, so a surfacing/paving job lives entirely here (not under Contours).
  const qk = { qarea: [], qline: [], qcount: [] };
  for (const m of state.markups) if (qk[m.kind] && onPage(m)) qk[m.kind].push(m);
  const qTotal = qk.qarea.length + qk.qline.length + qk.qcount.length;
  rows.push(`<div class="roof-sub dirt-collapse" data-act="toggle-takeoff"><span>Takeoffs (${qTotal})</span><span class="dirt-hd-r">${dirtEye('sec:takeoffs')}<span class="v">${dirtTakeoffCollapsed ? '▸' : '▾'}</span></span></div>`);
  if (!dirtTakeoffCollapsed) {
    if (!qTotal) {
      rows.push(`<div class="hint" style="margin:2px 0 8px">No area / line / count takeoffs ${dirtShowAllPages ? 'yet' : 'on this page'}. Trace one with the <b>▨ Area</b> / <b>⌇ Line</b> / <b>⊙ Count</b> tools — these price into the <b>$ Bid</b> and are separate from the cut/fill contours above.</div>`);
    } else {
      const icon = { qarea: '▨', qline: '⌇', qcount: '⊙' };
      // Build every (kind → material/type + color) group first, so e.g. gravel and
      // asphalt areas each get their own collapsible subheader (with its swatch).
      const allGroups = [];
      for (const kind of ['qarea', 'qline', 'qcount']) {
        const items = qk[kind];
        if (!items.length) continue;
        const groups = new Map();
        for (const m of items) {
          const color = kind === 'qline' ? lineColorHex(m.cfg || {}) : kind === 'qarea' ? areaColorHex(m.cfg || {}) : (m.color || '#e0533f');
          const label = takeoffGroupLabel(kind, m);
          const gkey = `t:${kind}:${label}:${color}`;
          const g = groups.get(gkey) || { kind, gkey, label, color, items: [] };
          g.items.push(m); groups.set(gkey, g);
        }
        for (const g of groups.values()) allGroups.push(g);
      }
      // Only one group across all takeoffs → skip the subheader (it would just
      // echo the section header). Two+ → collapsible per-material subgroups.
      const flat = allGroups.length <= 1;
      // Flat = no subgroup eye, so the section eye governs; clear any stale hidden
      // key for the lone group so it can't be stuck hidden with no eye to fix it.
      if (flat && allGroups[0]) dirtHidden.delete(allGroups[0].gkey);
      for (const g of allGroups) {
        if (!flat) {
          rows.push(dirtGroupHeader(g.gkey, `${icon[g.kind]} ${g.label}`, g.items.length, g.color));
          if (dirtGroupsCollapsed.has(g.gkey)) continue;
        }
        for (const m of g.items) {
          rows.push(`<div class="ctr-row${m.id === selectedId ? ' sel' : ''}" data-id="${m.id}">` +
            `<span class="ctr-sw" style="background:${g.color}"></span>` +
            `<span class="ctr-lbl">${icon[g.kind]} ${esc(measureValue(m))}${pageTag(m)}</span>` +
            `<button class="ctr-btn" data-act="edit-takeoff" title="Edit / reconfigure">✎</button>` +
            `<button class="ctr-btn" data-act="del-ctr" title="Delete">✕</button>` +
            `</div>`);
        }
        // per-material / per-type subtotal(s) for this group
        for (const s of takeoffSubtotals(g.kind, g.items)) {
          rows.push(`<div class="dirt-row"><span>Σ ${esc(s.label)}</span><span class="v"><b>${esc(s.text)}</b></span></div>`);
        }
      }
    }
  }
  // Earthwork (collapsible): boundary + grid settings + calculate
  rows.push(`<div class="roof-sub dirt-collapse" data-act="toggle-earthwork"><span>Earthwork</span><span class="v">${dirtEarthworkCollapsed ? '▸' : '▾'}</span></div>`);
  if (!dirtEarthworkCollapsed) {
    const newLink = '<a class="dirt-link" data-act="new-bound">new</a>';
    const editLink = c.boundary ? ' · <a class="dirt-link" data-act="edit-bound">edit</a>' : '';
    rows.push(`<div class="dirt-row"><span>Boundary</span><span class="v">${c.boundary ? 'set · ' : ''}${newLink}${editLink}</span></div>`);
    rows.push('<div class="dirt-set">Contour interval <input type="number" id="ewInterval" min="0" step="0.5"> ft <span class="hint">— next contour auto-steps by this</span></div>');
    rows.push('<div class="dirt-set">Grid <input type="number" id="ewGrid" min="0.5" step="0.5"> ft · Shrink <input type="number" id="ewShrink" min="0"> % · Swell <input type="number" id="ewSwell" min="0"> % · Truck <input type="number" id="ewTruck" min="1"> CY</div>');
    rows.push('<button class="btn go dirt-btn" data-act="calc">∑ Calculate Cut / Fill</button>');
  }
  if (E.result) {
    // same math as the standalone tool: fill needs bank dirt ÷(1−shrink);
    // net = cut − fillBank (+ = surplus leaves site); export hauls loose ×(1+swell)
    const R = E.result;
    const shrink = (Number(E.shrink) || 0) / 100;
    const swell = (Number(E.swell) || 0) / 100;
    const fillBank = R.fillCY / Math.max(0.01, 1 - shrink);
    const net = R.cutCY - fillBank;
    const isExport = net >= 0;
    const haul = Math.abs(net) * (isExport ? 1 + swell : 1);
    const loads = E.truckCap > 0 ? Math.ceil(haul / E.truckCap) : 0;
    rows.push('<div class="roof-sub">Results</div>');
    rows.push(`<div class="dirt-row"><span>Disturbed area</span><span class="v">${fmt(R.areaFt2 / 43560, 2)} ac</span></div>`);
    rows.push(`<div class="dirt-row"><span>Grid cell used</span><span class="v">${fmt(R.gridFt, 1)} ft</span></div>`);
    rows.push(`<div class="dirt-row"><span>Cut (bank)</span><span class="v">${fmt(R.cutCY, 0)} CY</span></div>`);
    rows.push(`<div class="dirt-row"><span>Fill (compacted)</span><span class="v">${fmt(R.fillCY, 0)} CY</span></div>`);
    rows.push(`<div class="dirt-row"><span>Fill in bank CY</span><span class="v">${fmt(fillBank, 0)} CY</span></div>`);
    rows.push(`<div class="dirt-row"><b>${isExport ? 'EXPORT off site' : 'IMPORT to site'}</b><span class="v"><b>${fmt(Math.abs(net), 0)} CY</b></span></div>`);
    if (isExport) rows.push(`<div class="dirt-row"><span>≈ truck volume (loose)</span><span class="v">${fmt(haul, 0)} CY</span></div>`);
    if (isExport && loads > 0) rows.push(`<div class="dirt-row"><span>≈ haul loads @ ${fmt(E.truckCap)} CY</span><span class="v">${fmt(loads, 0)}</span></div>`);
    rows.push('<div class="hint" style="margin:4px 0">Estimating numbers — verify scale, alignment, and traces before you bid.</div>');
  }
  const body = $('dirtBody');
  body.innerHTML = rows.join('');
  if (!dirtEarthworkCollapsed) {
    $('ewGrid').value = E.gridFt; $('ewShrink').value = E.shrink; $('ewSwell').value = E.swell; $('ewTruck').value = E.truckCap;
    $('ewInterval').value = E.interval != null ? E.interval : 1;
    const numHandler = (el, key, min, def) => el.addEventListener('change', e => { E[key] = Math.max(min, parseFloat(e.target.value) || def); e.target.value = E[key]; scheduleSave(); });
    numHandler($('ewInterval'), 'interval', 0, 1);
    numHandler($('ewGrid'), 'gridFt', 0.5, 5);
    numHandler($('ewShrink'), 'shrink', 0, 15);
    numHandler($('ewSwell'), 'swell', 0, 25);
    numHandler($('ewTruck'), 'truckCap', 1, 12);
    body.querySelector('[data-act="calc"]').addEventListener('click', calculateCutFill);
  }
  const setEx = body.querySelector('[data-act="set-existing"]');
  if (setEx) setEx.addEventListener('click', () => { E.existingPage = state.page; scheduleSave(); renderDirtPanel(); renderSurfaceToggle(); });
  const setPr = body.querySelector('[data-act="set-proposed"]');
  if (setPr) setPr.addEventListener('click', () => { E.proposedPage = state.page; scheduleSave(); renderDirtPanel(); renderSurfaceToggle(); });
  const toggleSheets = body.querySelector('[data-act="toggle-sheets"]');
  if (toggleSheets) toggleSheets.addEventListener('click', () => { dirtSheetsCollapsed = !dirtSheetsCollapsed; renderDirtPanel(); });
  const newBound = body.querySelector('[data-act="new-bound"]');
  if (newBound) newBound.addEventListener('click', () => setTool('ebound'));
  const editBound = body.querySelector('[data-act="edit-bound"]');
  if (editBound) editBound.addEventListener('click', () => { const b = state.markups.find(m => m.kind === 'ebound'); if (b) selectContourById(b.id); });
  const toggleEw = body.querySelector('[data-act="toggle-earthwork"]');
  if (toggleEw) toggleEw.addEventListener('click', () => { dirtEarthworkCollapsed = !dirtEarthworkCollapsed; renderDirtPanel(); });
  const doAlign = body.querySelector('[data-act="do-align"]');
  if (doAlign) doAlign.addEventListener('click', () => setTool('align'));
  const toggleContours = body.querySelector('[data-act="toggle-contours"]');
  if (toggleContours) toggleContours.addEventListener('click', () => { dirtContoursCollapsed = !dirtContoursCollapsed; renderDirtPanel(); });
  const toggleTakeoff = body.querySelector('[data-act="toggle-takeoff"]');
  if (toggleTakeoff) toggleTakeoff.addEventListener('click', () => { dirtTakeoffCollapsed = !dirtTakeoffCollapsed; renderDirtPanel(); });
  body.querySelectorAll('[data-act="toggle-group"]').forEach(el => {
    el.addEventListener('click', () => {
      const k = decodeURIComponent(el.dataset.gkey);
      if (dirtGroupsCollapsed.has(k)) dirtGroupsCollapsed.delete(k); else dirtGroupsCollapsed.add(k);
      renderDirtPanel();
    });
  });
  // Eye = hide/show that group on the PLAN. stopPropagation so clicking it doesn't
  // also fold the header it sits in. Redraw the canvas since visibility changed.
  body.querySelectorAll('[data-act="toggle-vis"]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const k = decodeURIComponent(el.dataset.vkey);
      if (dirtHidden.has(k)) dirtHidden.delete(k); else dirtHidden.add(k);
      renderDirtPanel();
      vp.requestDraw();
    });
  });
  const allPagesChk = body.querySelector('#showAllPagesChk');
  if (allPagesChk) allPagesChk.addEventListener('change', e => { dirtShowAllPages = e.target.checked; renderDirtPanel(); });
  const clearSurf = body.querySelector('[data-act="clear-surface"]');
  if (clearSurf) clearSurf.addEventListener('click', clearSurfaceContours);
  body.querySelectorAll('.ctr-row').forEach(row => {
    row.addEventListener('click', e => {
      const btn = e.target.closest('button');
      const id = row.dataset.id;
      if (btn && btn.dataset.act === 'edit-elev') { editContourElev(id); return; }
      if (btn && btn.dataset.act === 'edit-takeoff') { reconfigureTakeoff(state.markups.find(x => x.id === id)); return; }
      if (btn && btn.dataset.act === 'del-ctr') { deleteContourById(id); return; }
      selectContourById(id);
    });
  });
  const gk = body.querySelector('#ghostChk');
  if (gk) gk.addEventListener('change', e => { ghostOn = e.target.checked; vp.requestDraw(); });
}

// Contour-list actions (dirt panel) — mirror the sitework tool's list.
async function selectContourById(id) {
  const m = state.markups.find(x => x.id === id);
  if (!m) return;
  setTool('select'); // drop straight into edit mode so points are draggable right away
  selectedId = id;
  await setPage(m.page);
  // center the view on the picked trace (same as the markup-list jump)
  const bb = markupBBox(vp.ctx, m);
  const r = els.cv.parentElement.getBoundingClientRect();
  vp.view.panX = r.width / 2 - ((bb.x0 + bb.x1) / 2) * vp.view.zoom;
  vp.view.panY = r.height / 2 - ((bb.y0 + bb.y1) / 2) * vp.view.zoom;
  renderDirtPanel();
  vp.requestDraw();
  setMsg(!canReshape(m) ? 'Editing — drag to move it.'
    : isOpenPoly(m) ? 'Editing — drag a point to reshape · Alt-click: add / remove a point · Shift+Alt-click a segment: cut.'
    : 'Editing — drag a point to reshape · Alt-click an edge to add a point, a point to remove it.');
}
function editContourElev(id) {
  const m = state.markups.find(x => x.id === id);
  if (!m) return;
  modals.askNumber(`Edit elevation (ft) — ${m.surface === 'proposed' ? 'proposed' : 'existing'}`, 'e.g. 812.5',
    m.elev != null ? m.elev : '', 1)
    .then(v => { if (v != null) { const prev = snapshot(); m.elev = v; lastElev[m.surface] = v; state.earthwork.result = null; pushUndo(prev); markupsChanged(); } });
}
function deleteContourById(id) {
  if (!state.markups.some(x => x.id === id)) return;
  const prev = snapshot();
  state.markups = state.markups.filter(x => x.id !== id);
  if (selectedId === id) selectedId = null;
  state.earthwork.result = null;
  pushUndo(prev);
  markupsChanged();
}
// Re-open the config form for an area/line/count takeoff (from the side-menu ✎ or
// a double-click) and apply the new cfg as one undo step. Same forms as drawing.
function reconfigureTakeoff(m) {
  if (!m) return;
  selectedId = m.id; vp.requestDraw();
  const s = state.scales[m.page] || 0;
  const apply = cfg => { if (!cfg) return; const prev = snapshot(); m.cfg = cfg; pushUndo(prev); markupsChanged(); };
  if (m.kind === 'qarea') askAreaConfig(polygonAreaFt2(m.pts, s), areaPerimeterFt(m), m.cfg).then(cfg => { if (cfg) rememberAreaCfg(cfg); apply(cfg); });
  else if (m.kind === 'qline') askLineConfig(polyLengthFt(m.pts, s), m.cfg).then(cfg => { if (cfg) { lastLineCfg = cfg; lastLineColor = cfg.color; } apply(cfg); });
  else if (m.kind === 'qcount') askCountConfig(m.pts.length, m.cfg).then(cfg => { if (cfg) lastCountCfg = cfg; apply(cfg); });
}
function clearSurfaceContours() {
  const ids = new Set(state.markups
    .filter(m => (m.kind === 'contour' || m.kind === 'espot' || m.kind === 'epad') && (m.surface || 'existing') === curSurface)
    .map(m => m.id));
  if (!ids.size) return;
  if (!window.confirm(`Delete all ${ids.size} traced ${curSurface} line${ids.size === 1 ? '' : 's'} on this surface? This can be undone.`)) return;
  const prev = snapshot();
  state.markups = state.markups.filter(m => !ids.has(m.id));
  if (selectedId && ids.has(selectedId)) selectedId = null;
  state.earthwork.result = null;
  pushUndo(prev);
  markupsChanged();
}

function syncDirtInputs() { renderDirtPanel(); }

/* Cut/fill compute — ported from the standalone sitework tool (see
   shared/PARITY.md). One adaptation: sitework stores both surfaces in one
   world space; Plan Room keeps geometry in native page coords and maps the
   PROPOSED surface into existing space through the align transform here. */

let heatGrid = null; // session-only heat overlay {page,x0,y0,cellPx,cols,rows,dz,maxAbs}

// Classic linear-between-contours: elevation at a point = distance-weighted
// blend of the nearest contour and the nearest contour at a DIFFERENT
// elevation; flat inside pads. (Copied verbatim from sitework.)
function makeInterpolator(contours) {
  const n = contours.length;
  const dists = new Float64Array(n);
  const pads = contours.filter(c => c.pad);
  const rings = contours.map(c => c.pad ? c.pts.concat([c.pts[0]]) : c.pts);
  return function (px, py) {
    for (const p of pads)
      if (pointInPolygon(px, py, p.pts)) return p.elev;
    let d1 = Infinity, z1 = null;
    for (let i = 0; i < n; i++) {
      const d = distToPolyline(px, py, rings[i]);
      dists[i] = d;
      if (d < d1) { d1 = d; z1 = contours[i].elev; }
    }
    if (z1 === null) return null;
    let d2 = Infinity, z2 = null;
    for (let i = 0; i < n; i++) {
      if (contours[i].elev !== z1 && dists[i] < d2) { d2 = dists[i]; z2 = contours[i].elev; }
    }
    if (z2 === null || d1 === 0) return z1;
    return (z1 * d2 + z2 * d1) / (d1 + d2);
  };
}

// A surface's contours/spots/pads, mapped into EXISTING-sheet space.
function surfaceInputs(surface) {
  const E = state.earthwork;
  const wantPage = surface === 'existing' ? E.existingPage : E.proposedPage;
  const mapPt = (surface === 'proposed' && E.existingPage !== E.proposedPage)
    ? p => alignApply(E.align, p)
    : p => ({ x: p.x, y: p.y });
  return state.markups
    .filter(m => ['contour', 'espot', 'epad'].includes(m.kind) && m.surface === surface && m.elev != null && m.page === wantPage)
    .map(m => ({ pts: m.pts.map(mapPt), elev: m.elev, pad: m.kind === 'epad' }));
}

async function calculateCutFill() {
  const E = state.earthwork;
  const problems = [];
  if (!state.doc) problems.push('open the plan set');
  if (!E.existingPage) problems.push('designate the Existing sheet');
  if (!E.proposedPage) problems.push('designate the Proposed sheet');
  const ftPerPx = E.existingPage ? (state.scales[E.existingPage] || 0) : 0;
  if (E.existingPage && !ftPerPx) problems.push(`calibrate the Existing sheet (📏 on page ${E.existingPage})`);
  if (E.existingPage && E.proposedPage && E.existingPage !== E.proposedPage && !alignIsSet()) problems.push('align the sheets (⌖)');
  const bound = state.markups.find(m => m.kind === 'ebound');
  if (!bound) problems.push('trace the earthwork boundary (⬚)');
  const exist = E.existingPage ? surfaceInputs('existing') : [];
  const prop = E.proposedPage ? surfaceInputs('proposed') : [];
  if (E.existingPage && !exist.length) problems.push(`trace at least one Existing contour/spot/pad (with elevation) on page ${E.existingPage}`);
  if (E.proposedPage && !prop.length) problems.push(`trace at least one Proposed contour/spot/pad (with elevation) on page ${E.proposedPage}`);
  if (problems.length) { setMsg('Before calculating: ' + problems.join(', ') + '.'); return; }

  // boundary into existing space
  let bpts;
  if (bound.page === E.existingPage) bpts = bound.pts;
  else if (bound.page === E.proposedPage) bpts = bound.pts.map(p => alignApply(E.align, p));
  else { setMsg(`The boundary is on page ${bound.page} — trace it on the Existing or Proposed sheet.`); return; }

  const distinct = list => new Set(list.map(c => c.elev)).size;
  if (distinct(exist) < 2) setMsg('Heads up: only one distinct Existing elevation — that surface will be flat.');
  if (distinct(prop) < 2) setMsg('Heads up: only one distinct Proposed elevation — that surface will be flat.');

  let gridFt = Math.max(0.5, E.gridFt || 5);
  let cellPx = gridFt / ftPerPx;
  const xs = bpts.map(p => p.x), ys = bpts.map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);

  // cap grid size so the browser stays responsive (coarsen for huge sites)
  const MAXCELLS = 60000;
  let cols = Math.ceil((x1 - x0) / cellPx), rows = Math.ceil((y1 - y0) / cellPx);
  if (cols * rows > MAXCELLS) {
    const f = Math.sqrt((cols * rows) / MAXCELLS);
    cellPx *= f; gridFt *= f;
    cols = Math.ceil((x1 - x0) / cellPx); rows = Math.ceil((y1 - y0) / cellPx);
    setMsg(`Large site — grid coarsened to ${gridFt.toFixed(1)} ft cells to stay fast.`);
  }

  const interpE = makeInterpolator(exist);
  const interpP = makeInterpolator(prop);
  const dz = new Array(cols * rows).fill(null);
  const cellAreaFt2 = (cellPx * ftPerPx) ** 2;
  let cutFt3 = 0, fillFt3 = 0, cellsInside = 0, maxAbs = 0.01;

  for (let r = 0; r < rows; r++) {
    const cy = y0 + (r + 0.5) * cellPx;
    for (let cI = 0; cI < cols; cI++) {
      const cx = x0 + (cI + 0.5) * cellPx;
      if (!pointInPolygon(cx, cy, bpts)) continue;
      const ze = interpE(cx, cy);
      const zp = interpP(cx, cy);
      if (ze === null || zp === null) continue;
      const d = zp - ze;           // + fill, − cut
      dz[r * cols + cI] = d;
      cellsInside++;
      if (d > 0) fillFt3 += d * cellAreaFt2;
      else cutFt3 += -d * cellAreaFt2;
      if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d);
    }
    if (r % 24 === 23) { // chunk by rows to keep the UI alive on big grids
      setMsg(`Calculating… ${Math.round((r / rows) * 100)}%`);
      await new Promise(res => setTimeout(res, 0));
    }
  }

  // summary persists with the project; the heavy grid stays session-only
  E.result = { cutCY: cutFt3 / 27, fillCY: fillFt3 / 27, areaFt2: cellsInside * cellAreaFt2, gridFt };
  heatGrid = { page: E.existingPage, x0, y0, cellPx, cols, rows, dz, maxAbs };
  scheduleSave();
  renderDirtPanel();
  if (state.page !== E.existingPage) await setPage(E.existingPage);
  vp.requestDraw();
  setMsg('Done — volumes in the ⛰ Dirt panel; the overlay shows cut (red) and fill (blue). Verify scale and traces before you bid.');
}

// cut/fill heat overlay on the existing sheet (copied from sitework)
function drawHeat(ctx) {
  const g = heatGrid;
  ctx.save();
  ctx.globalAlpha = 0.45;
  for (let r = 0; r < g.rows; r++) {
    for (let cI = 0; cI < g.cols; cI++) {
      const dz = g.dz[r * g.cols + cI];
      if (dz === null || Math.abs(dz) < 0.02) continue;
      const t = Math.min(1, Math.abs(dz) / g.maxAbs);
      ctx.fillStyle = dz < 0
        ? `rgba(224,85,85,${0.25 + 0.75 * t})`     // cut
        : `rgba(77,163,255,${0.25 + 0.75 * t})`;   // fill
      ctx.fillRect(g.x0 + cI * g.cellPx, g.y0 + r * g.cellPx, g.cellPx + 0.5, g.cellPx + 0.5);
    }
  }
  ctx.restore();
}

// Earthwork panel has no toolbar button — it auto-opens on entering dirt mode.
// The ✕ in its header closes it; the floating ⛰ button (top-right) reopens it.
if ($('btnDirtClose')) $('btnDirtClose').addEventListener('click', () => {
  $('dirtPanel').classList.add('hidden');
  syncPanelButtons();
});
if ($('btnDirtOpen')) $('btnDirtOpen').addEventListener('click', () => {
  const p = $('dirtPanel');
  if (p.classList.contains('hidden')) {
    closeOtherPanels('dirtPanel');
    p.classList.remove('hidden');
    dirtSheetsCollapsed = dirtSetupComplete();
    renderDirtPanel();
  }
  syncPanelButtons();
});
// Existing ⇄ Proposed is a click-to-toggle (no dropdown): each click flips which
// surface new contours/spots/pads belong to.
function renderSurfaceToggle() {
  const btn = $('surfaceToggle'); if (!btn) return;
  const E = state.earthwork;
  const bothSet = !!(E.existingPage && E.proposedPage);
  const lbl = $('surfaceToggleLabel'); if (lbl) lbl.textContent = curSurface === 'proposed' ? 'Proposed' : 'Existing';
  const curPage = curSurface === 'proposed' ? E.proposedPage : E.existingPage;
  const away = bothSet && !!curPage && state.page !== curPage; // viewing a different page than this surface's sheet
  btn.classList.toggle('surf-off', !bothSet);   // grayed until both sheets are designated
  btn.classList.toggle('surf-away', away);        // white (border + text): a click jumps to this surface's sheet
  btn.classList.toggle('surf-existing', bothSet && !away && curSurface !== 'proposed');
  btn.classList.toggle('surf-proposed', bothSet && !away && curSurface === 'proposed');
  // the ⌖ align tool only appears once both sheets are set
  const align = document.querySelector('.tool[data-tool="align"]');
  if (align) { align.classList.toggle('hidden', !bothSet); if (!bothSet && tool === 'align') setTool('pan'); }
}
function setSurface(s) {
  curSurface = s === 'proposed' ? 'proposed' : 'existing';
  renderSurfaceToggle();
  // Jump to that surface's designated sheet (they're usually different pages).
  const E = state.earthwork;
  const target = curSurface === 'proposed' ? E.proposedPage : E.existingPage;
  if (target && target !== state.page) { setPage(target); setMsg(`Switched to the ${curSurface} sheet (page ${target}).`); }
  else if (!target) setMsg(`New traces are now ${curSurface} — set its sheet in the ⛰ Dirt panel (“Set current page as ${curSurface === 'proposed' ? 'Proposed' : 'Existing'}”).`);
  renderDirtPanel();
  vp.requestDraw(); // re-apply the surface visibility filter (esp. same-sheet, no page change)
}
if ($('surfaceToggle')) {
  renderSurfaceToggle();
  $('surfaceToggle').addEventListener('click', () => {
    const E = state.earthwork;
    if (!E.existingPage || !E.proposedPage) return; // grayed — nothing to toggle until both sheets are set
    const curPage = curSurface === 'proposed' ? E.proposedPage : E.existingPage;
    if (curPage && state.page !== curPage) {
      // "white" — you're on another page; jump to THIS surface's sheet rather than switching surface
      setPage(curPage);
      setMsg(`Jumped to the ${curSurface} sheet (page ${curPage}).`);
    } else {
      setSurface(curSurface === 'proposed' ? 'existing' : 'proposed'); // on the sheet → toggle to the other surface
    }
  });
}

/* ============================== Topbar & keyboard ============================== */

els.btnPrev.addEventListener('click', () => setPage(state.page - 1));
els.btnNext.addEventListener('click', () => setPage(state.page + 1));
els.btnFit.addEventListener('click', async () => {
  if (!state.doc) return;
  const b = await baseSize(state.page);
  // already showing the whole sheet? a second Fit fills the black space instead
  // of doing nothing (usually vertically, for a wide sheet). Fit again → contain.
  if (vp.isAtFit(b.width, b.height)) {
    vp.fitTo(b.width, b.height, { cover: true });
    setMsg('Filled to the view — drag to see the edges. Fit again to show the whole sheet.');
  } else {
    vp.fitTo(b.width, b.height);
  }
});
if ($('btnThumbsClose')) $('btnThumbsClose').addEventListener('click', () => document.body.classList.add('nothumbs'));
if ($('btnThumbsOpen')) $('btnThumbsOpen').addEventListener('click', () => document.body.classList.remove('nothumbs'));

document.addEventListener('keydown', e => {
  // Undo / redo FIRST, so an open Projects / Company / Bid panel can't swallow the
  // shortcut. Only a modal dialog (mid-edit) or typing in a field suppresses it.
  const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable);
  if (!typing && (e.ctrlKey || e.metaKey) && !modals.isOpen()) {
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
  }
  const companyOpen = !$('company').classList.contains('hidden');
  const bidOpen = !$('roofBid').classList.contains('hidden');
  if (modals.isOpen() || companyOpen || bidOpen || !els.projects.classList.contains('hidden')) {
    if (e.key === 'Escape' && !modals.isOpen()) {
      if (companyOpen) $('company').classList.add('hidden');
      if (bidOpen) $('roofBid').classList.add('hidden');
      els.projects.classList.add('hidden');
    }
    return;
  }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Enter' && alignDraft) { // accept the shift-only alignment
    e.preventDefault();
    alignDraft = null;
    setTool('pan');
    setMsg('Alignment saved (shift only). Turn on Ghost in the ⛰ Dirt panel to double-check the fit.');
    return;
  }
  if (e.key === 'Escape' && alignDraft) {
    e.preventDefault();
    if (!alignDraft.qs.length) state.earthwork.align = alignDraft.prevAlign; // nothing applied yet — restore
    alignDraft = null;
    vp.requestDraw();
    setMsg('Alignment cancelled.');
    return;
  }
  // Shift+Enter: weld the current end to the shape's other end (close the loop),
  // then finish — the closing shortcut for both an extend session and a draft.
  if (e.key === 'Enter' && e.shiftKey && extend) { e.preventDefault(); closeExtendLoop(); return; }
  if (e.key === 'Enter' && e.shiftKey && draft) { e.preventDefault(); closeDraftAndCommit(); return; }
  if (e.key === 'Enter' && extend) { e.preventDefault(); extend = null; hoverW = null; setMsg('Finished.'); vp.requestDraw(); return; }
  if (e.key === 'Enter' && draft) { e.preventDefault(); commitDraft(); return; }
  if (e.key === 'Backspace' && draft) {
    e.preventDefault();
    if (draft.pts.length) { const prev = JSON.stringify(draft.pts); draft.pts.pop(); draftRecord(prev); }
    if (!draft.pts.length) cancelDraft(); else vp.requestDraw();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelected(); return; }
  if (e.key === 'Escape') {
    if (extend) { extend = null; hoverW = null; setMsg('Finished extending.'); vp.requestDraw(); }
    else if (moveEnd) { moveEnd = null; setMsg('Disconnected.'); vp.requestDraw(); }
    else if (draft || calibPts) { cancelDraft(); }
    else if (drag) { drag = null; vp.requestDraw(); }
    else if (selectedId) { selectedId = null; renderMarkupList(); vp.requestDraw(); }
    return;
  }
  if (e.key === 'PageDown') { e.preventDefault(); setPage(state.page + 1); }
  if (e.key === 'PageUp') { e.preventDefault(); setPage(state.page - 1); }
  const PAN = 0.12;
  if (e.key === 'ArrowLeft') vp.panByFraction(-PAN, 0);
  if (e.key === 'ArrowRight') vp.panByFraction(PAN, 0);
  if (e.key === 'ArrowUp') vp.panByFraction(0, -PAN);
  if (e.key === 'ArrowDown') vp.panByFraction(0, PAN);
});

/* ============================== Projects (local-first) ============================== */

function projectData() {
  return {
    app: 'plan-room', version: 1, page: state.page,
    markups: state.markups, scales: state.scales, scaleBars: state.scaleBars,
    roofPitch: state.roofPitch, roofWaste: state.roofWaste,
    roofPrices: state.roofPrices, roofOP: state.roofOP,
    earthwork: state.earthwork,
    trade: state.trade,
    bidMeta: state.bidMeta,
    drywall: state.drywall,
    flooring: state.flooring,
    framing: state.framing,
    esc: state.esc,
    striping: state.striping,
    siding: state.siding,
    demo: state.demo,
    fence: state.fence,
    landscape: state.landscape,
    estimateId: state.estimateId || null,
  };
}
const defaultDrywall = () => ({ wallHeight: 9, sheetSF: 32, waste: 10, coverage: 375, coats: 2, finish: 'L4', texture: 'none', insul: 'none' });
const defaultFlooring = () => ({ waste: 10, underlay: 'none', tileSize: '12x12', groutJoint: '3/16', thinsetCov: 95 });
const defaultFraming = () => ({ spacing: 16, height: 9, topPlates: 2, sheathWaste: 10 });
const defaultEsc = () => ({ entranceDepth: 6, stoneDensity: 105, seedRate: 200, mulchRate: 2, blanketWaste: 10, riprapDepth: 12 });
const defaultStriping = () => ({ coverage4in: 320, beadRate: 6, coats: 1 });
const defaultSiding = () => ({ waste: 10, insulWaste: 5, battCoverage: 88 });
const defaultDemo = () => ({ swell: 50, truckCap: 12, thickAsphalt: 3, thickConcrete: 6, thickSidewalk: 4, thickGravel: 6 });
const defaultFence = () => ({ holeDia: 10, holeDepth: 30, bagCF: 0.45 });
const defaultLandscape = () => ({ mulchDepth: 3, rockDepth: 3, bedDepth: 6, rockDensity: 100, sodWaste: 5, seedRate: 5 });
const defaultEarthwork = () => ({ existingPage: null, proposedPage: null, align: { a: 1, b: 0, e: 0, f: 0 }, gridFt: 5, shrink: 15, swell: 25, truckCap: 12, interval: 1, result: null });
// next contour's default elevation = last + interval (auto-steps up a slope)
const nextElevDefault = surf => { const iv = Number(state.earthwork.interval) || 0; return lastElev[surf] != null ? lastElev[surf] + iv : ''; };

let saveTimer = null;
function scheduleSave(now = false) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProjectNow, now ? 0 : 600);
  if (typeof sessionSyncSoon === 'function') sessionSyncSoon(); // push live edits (no-op if not in a session / applying incoming)
}
// discreet "✓ Saved" flash in the canvas top-left on each autosave write —
// nudged to the right of the HUD message when one is showing so they don't stack.
let savedTimer = null;
function positionSaveStatus(el) {
  const hud = els.hud;
  const hudShowing = hud && hud.textContent.trim() && !hud.classList.contains('gone');
  el.style.left = hudShowing ? (hud.offsetLeft + hud.offsetWidth + 8) + 'px' : (document.body.classList.contains('nothumbs') ? '48px' : '10px');
}
function flashSaved() {
  const el = $('saveStatus');
  if (!el) return;
  el.classList.remove('save-error');   // a successful save clears any prior warning
  el.textContent = '✓ Saved';
  positionSaveStatus(el);
  el.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('show'), 1600);
}
// A save FAILED. Unlike the "✓ Saved" flash, this stays put (no auto-hide) until
// a later save succeeds — a silently-dropped save is exactly how work gets lost,
// so it must stay visible until it's resolved.
function flashSaveError() {
  const el = $('saveStatus');
  if (!el) return;
  clearTimeout(savedTimer);
  el.textContent = '⚠ NOT SAVED — browser storage may be full';
  positionSaveStatus(el);
  el.classList.add('show', 'save-error');
}
// A save failed during a deliberate action (adding pages) where losing it would
// wipe real work — make it impossible to miss.
function saveError(msg) {
  flashSaveError();
  setMsg(msg);
  alert('⚠ Could not save\n\n' + msg);
}
async function saveProjectNow() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!state.projectId) return;
  try {
    await store.projPut({
      id: state.projectId,
      name: state.projectName || 'Project',
      modified: Date.now(),
      docKey: state.docKey || null,
      docName: state.docName || null,
      docType: state.docType || null,
      data: projectData(),
    });
    flashSaved();
  } catch (err) {
    // Don't swallow it — a silently-dropped autosave is how a whole session's
    // work vanishes on the next reload. Leave the NOT SAVED banner up until a
    // later autosave succeeds.
    console.error('autosave failed', err);
    flashSaveError();
  }
}

function updateProjectBtn() { els.projName.textContent = state.projectName || 'Project'; }

function resetDocState() {
  state.doc = null; state.docKey = null; state.docName = null; state.docType = null; state.page = 1;
  state.serverId = null; state.serverVersion = null;
  heatGrid = null;
  alignDraft = null;
  if (typeof clearPathCache === 'function') clearPathCache();
  selectedId = null;
  cancelOverlay();
  undoStack.length = 0; redoStack.length = 0; updateUndoButtons();
  pageCanvas.clear(); pageBase.clear(); inflight.clear(); pageHasText.clear();
  els.thumbRail.innerHTML = '';
  els.dropHint.classList.remove('hidden');
  document.body.classList.remove('has-doc');
  updatePageUI();
  vp.requestDraw();
}

async function openProject(rec) {
  await saveProjectNow(); // flush the outgoing project first
  state.projectId = rec.id;
  state.projectName = rec.name;
  resetDocState();
  state.markups = (rec.data && Array.isArray(rec.data.markups)) ? rec.data.markups : [];
  state.scales = (rec.data && rec.data.scales) || {};
  state.scaleBars = (rec.data && rec.data.scaleBars) || {};
  state.roofPitch = (rec.data && rec.data.roofPitch != null) ? rec.data.roofPitch : 6;
  state.roofWaste = (rec.data && rec.data.roofWaste != null) ? rec.data.roofWaste : 12;
  state.roofPrices = (rec.data && rec.data.roofPrices) || {};
  state.roofOP = (rec.data && rec.data.roofOP != null) ? rec.data.roofOP : 15;
  state.earthwork = (rec.data && rec.data.earthwork) || defaultEarthwork();
  state.trade = (rec.data && rec.data.trade) || '';
  state.bidMeta = (rec.data && rec.data.bidMeta) || {};
  state.drywall = (rec.data && rec.data.drywall) || defaultDrywall();
  state.flooring = (rec.data && rec.data.flooring) || defaultFlooring();
  state.framing = (rec.data && rec.data.framing) || defaultFraming();
  state.esc = (rec.data && rec.data.esc) || defaultEsc();
  state.striping = (rec.data && rec.data.striping) || defaultStriping();
  state.siding = (rec.data && rec.data.siding) || defaultSiding();
  state.demo = (rec.data && rec.data.demo) || defaultDemo();
  state.fence = (rec.data && rec.data.fence) || defaultFence();
  state.landscape = (rec.data && rec.data.landscape) || defaultLandscape();
  state.estimateId = (rec.data && rec.data.estimateId) || null;
  renderMarkupList(); syncRoofInputs(); syncDirtInputs(); syncDwInputs(); syncTradeUI();
  try { localStorage.setItem('planroom-current', rec.id); } catch (_) {}
  updateProjectBtn();
  if (rec.docKey) {
    try {
      const f = await store.filesGet(rec.docKey);
      if (f && f.bytes) {
        state.docKey = rec.docKey;
        await openFromBytes(f.bytes, f.name || rec.docName || 'plans', f.type || rec.docType, { persist: false });
        if (rec.data && rec.data.page) await setPage(rec.data.page);
      } else {
        setMsg(`"${rec.name}" opened — its plans (${rec.docName || '?'}) aren't stored here; use Open Plans….`);
      }
    } catch (_) {
      setMsg(`"${rec.name}" opened — could not reopen its plans; use Open Plans….`);
    }
  } else {
    setMsg(`"${rec.name}" opened. Open a plan set to get started.`);
  }
  els.projects.classList.add('hidden');
}

async function newProject(name) {
  await saveProjectNow();
  state.projectId = randId();
  state.projectName = name || 'Project ' + new Date().toLocaleDateString();
  resetDocState();
  state.markups = [];
  state.scales = {};
  state.scaleBars = {};
  state.roofPitch = 6; state.roofWaste = 12; state.roofPrices = {}; state.roofOP = 15;
  state.earthwork = defaultEarthwork();
  state.trade = '';
  state.bidMeta = {};
  state.drywall = defaultDrywall();
  state.flooring = defaultFlooring();
  state.framing = defaultFraming();
  state.esc = defaultEsc();
  state.striping = defaultStriping();
  state.siding = defaultSiding();
  state.demo = defaultDemo();
  state.fence = defaultFence();
  state.landscape = defaultLandscape();
  state.estimateId = null;
  renderMarkupList(); syncRoofInputs(); syncDirtInputs(); syncDwInputs(); syncTradeUI();
  try { localStorage.setItem('planroom-current', state.projectId); } catch (_) {}
  updateProjectBtn();
  await saveProjectNow();
  setMsg(`"${state.projectName}" created. Open a plan set to get started.`);
}

function renderProjCurrent() {
  const n = state.doc ? state.doc.numPages : 0;
  const hasDoc = !!state.doc;
  const meta = hasDoc
    ? `${esc(state.docName || 'plans')} · ${n} sheet${n === 1 ? '' : 's'}`
    : 'No plans loaded yet.';
  $('projCurrent').innerHTML = `
    <div class="pc-name"></div>
    <div class="pc-meta">${meta}</div>
    <div class="pc-actions">
      <button id="pcOpen" class="btn primary">${hasDoc ? '＋ Add more sheets…' : '📄 Open plans…'}</button>
      ${hasDoc && n > 1 ? '<button id="pcSheets" class="btn">🗂 Manage sheets</button>' : ''}
      <button id="pcLoad" class="btn">📂 Load saved file</button>
      <button id="pcCompany" class="btn">☁ Company / join live</button>
    </div>`;
  $('projCurrent').querySelector('.pc-name').textContent = state.projectName || 'Project';
  $('pcOpen').addEventListener('click', pickPlans);
  if ($('pcSheets')) $('pcSheets').addEventListener('click', () => { els.projects.classList.add('hidden'); openSheetMgr(); });
  $('pcLoad').addEventListener('click', () => $('fileImport').click());
  $('pcCompany').addEventListener('click', () => { els.projects.classList.add('hidden'); openCompany(); });
}

async function showProjects() {
  await saveProjectNow();
  renderProjCurrent();
  let recs = [];
  try { recs = (await store.projAll()).sort((a, b) => (b.modified || 0) - (a.modified || 0)); } catch (_) {}
  els.projList.innerHTML = '';
  for (const r of recs) {
    const row = document.createElement('div');
    row.className = 'proj-row' + (r.id === state.projectId ? ' current' : '');
    const when = r.modified ? new Date(r.modified).toLocaleDateString() : '';
    const nMk = (r.data && r.data.markups && r.data.markups.length) || 0;
    row.innerHTML = `
      <div class="grow">
        <div class="name"></div>
        <div class="meta">${r.docName ? esc(r.docName) + ' · ' : ''}${nMk} markup${nMk === 1 ? '' : 's'} · ${when}</div>
      </div>
      ${r.id === state.projectId ? '<span class="pill">current</span>' : '<button class="btn tiny" data-act="open">Open</button>'}
      <button class="btn tiny" data-act="ren" title="Rename">Rename</button>
      <button class="btn tiny danger" data-act="del" title="Delete this project">✕</button>`;
    row.querySelector('.name').textContent = r.name;
    row.querySelector('.grow').addEventListener('click', () => openProject(r));
    const openBtn = row.querySelector('[data-act="open"]');
    if (openBtn) openBtn.addEventListener('click', () => openProject(r));
    row.querySelector('[data-act="ren"]').addEventListener('click', async () => {
      const name = await modals.askText('Rename project', '', r.name);
      if (!name) return;
      r.name = name;
      await store.projPut(r);
      if (r.id === state.projectId) { state.projectName = name; updateProjectBtn(); }
      showProjects();
    });
    row.querySelector('[data-act="del"]').addEventListener('click', async () => {
      const ok = await modals.askModal({
        title: `Delete "${r.name}"?`,
        body: '<div class="hint">Removes this project and its markups permanently (no undo). Its plan file is removed too if no other project uses it.</div>',
      });
      if (ok === null) return;
      await store.projDelete(r.id);
      const rest = (await store.projAll()).filter(x => x.id !== r.id);
      if (r.docKey && !rest.some(x => x.docKey === r.docKey)) await store.filesDelete(r.docKey).catch(() => {});
      if (r.id === state.projectId) {
        if (rest.length) await openProject(rest.sort((a, b) => (b.modified || 0) - (a.modified || 0))[0]);
        else await newProject('Project 1');
      }
      showProjects();
    });
    els.projList.appendChild(row);
  }
  els.projects.classList.remove('hidden');
}

$('btnProjects').addEventListener('click', showProjects);
$('btnJumpStart').addEventListener('click', runJumpStart);
document.querySelectorAll('#navPads .nav-pad').forEach(b => b.addEventListener('click', () => {
  vp.panByFraction(parseInt(b.dataset.dx, 10) / 3, parseInt(b.dataset.dy, 10) / 3);
}));
$('projClose').addEventListener('click', () => els.projects.classList.add('hidden'));
els.projects.addEventListener('click', e => { if (e.target === els.projects) els.projects.classList.add('hidden'); });
$('btnProjNew').addEventListener('click', async () => {
  els.projects.classList.add('hidden'); // close first — the name prompt would otherwise render behind it
  const name = await modals.askText('New project', 'Name the project', '');
  if (name === null) return;
  await newProject(name);
});

/* ============================== Save / load file ============================== */

$('btnExport').addEventListener('click', async () => {
  if (!state.doc && !state.markups.length) { setMsg('Nothing to save yet — open a plan set first.'); return; }
  setMsg('Building the file…');
  let docB64 = null;
  try {
    const f = state.docKey ? await store.filesGet(state.docKey) : null;
    if (f && f.bytes) docB64 = bytesToBase64(f.bytes);
  } catch (_) {}
  const out = {
    app: 'plan-room', version: 1, // Load checks this marker — must be present
    ...projectData(),
    name: state.projectName,
    docName: state.docName, docType: state.docType, docB64,
  };
  const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (state.projectName || 'plan-room').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '.planroom.json';
  a.click();
  URL.revokeObjectURL(a.href);
  setMsg('Saved. The file has the plans and markups embedded — hand it to anyone.');
});

$('fileImport').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let d;
  try { d = JSON.parse(await file.text()); } catch (_) { setMsg('That is not a Plan Room file.'); return; }
  // accept marked files, plus older saves that predate the marker (by shape),
  // but reject files exported by a different tool
  const ok = d && (d.app === 'plan-room' || (!d.app && (Array.isArray(d.markups) || d.docB64)));
  if (!ok) { setMsg('That is not a Plan Room file.'); return; }
  // Always land in a NEW project — never overwrite the one that's open. Suffix
  // the name so an imported copy is obviously distinct from its source.
  const baseName = d.name || file.name.replace(/\.planroom\.json$|\.json$/i, '');
  await newProject(/\(imported\)\s*$/.test(baseName) ? baseName : `${baseName} (imported)`);
  state.markups = Array.isArray(d.markups) ? d.markups : [];
  state.scales = d.scales || {};
  state.scaleBars = d.scaleBars || {};
  if (d.roofPitch != null) state.roofPitch = d.roofPitch;
  if (d.roofWaste != null) state.roofWaste = d.roofWaste;
  state.roofPrices = d.roofPrices || {};
  if (d.roofOP != null) state.roofOP = d.roofOP;
  state.earthwork = d.earthwork || defaultEarthwork();
  state.trade = d.trade || '';
  state.bidMeta = d.bidMeta || {};
  state.drywall = d.drywall || defaultDrywall();
  state.flooring = d.flooring || defaultFlooring();
  state.framing = d.framing || defaultFraming();
  state.esc = d.esc || defaultEsc();
  state.striping = d.striping || defaultStriping();
  state.siding = d.siding || defaultSiding();
  state.demo = d.demo || defaultDemo();
  state.fence = d.fence || defaultFence();
  state.landscape = d.landscape || defaultLandscape();
  state.estimateId = d.estimateId || null;
  renderMarkupList(); syncRoofInputs(); syncDirtInputs(); syncDwInputs(); syncTradeUI();
  if (d.docB64) {
    const bytes = base64ToBytes(d.docB64);
    await openFromBytes(bytes.buffer, d.docName || 'plans.pdf', d.docType);
    if (d.page) await setPage(d.page);
  }
  updateProjectBtn();
  await saveProjectNow();
  setMsg(`Loaded as a new project “${state.projectName}”. Your previous project is still in 📁 Projects.`);
});

/* ============================== Export (flatten + CSV) ============================== */

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function safeName() {
  return (state.projectName || 'plan-room').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'plan-room';
}

// Render one page's markups onto a transparent canvas (world coords), for
// embedding over the PDF page. Raster overlay: reliable for every markup
// kind, and the original page's vector content stays untouched underneath.
async function markupOverlayPng(p) {
  const base = await baseSize(p);
  const S = Math.min(3, Math.max(1.5, 3000 / base.width));
  const c = document.createElement('canvas');
  c.width = Math.ceil(base.width * S);
  c.height = Math.ceil(base.height * S);
  const ctx = c.getContext('2d');
  ctx.scale(S, S);
  for (const m of state.markups) if (m.page === p) drawMarkup(ctx, m);
  return c.toDataURL('image/png');
}

async function exportFlatPdf() {
  if (!state.doc) { setMsg('Open a plan set first.'); return; }
  setMsg('Building the marked-up PDF…');
  try {
    const { PDFDocument, degrees } = PDFLib;
    const pagesWith = new Set(state.markups.map(m => m.page));
    let out;
    if (state.doc.kind === 'pdf') {
      const f = state.docKey ? await store.filesGet(state.docKey) : null;
      if (!f || !f.bytes) throw new Error('the original PDF is not stored on this device');
      out = await PDFDocument.load(f.bytes.slice(0), { ignoreEncryption: true });
      const pages = out.getPages();
      for (const p of pagesWith) {
        const page = pages[p - 1];
        if (!page) continue;
        setMsg(`Flattening sheet ${p}…`);
        const png = await out.embedPng(await markupOverlayPng(p));
        const rot = ((page.getRotation().angle % 360) + 360) % 360;
        const W = page.getWidth(), H = page.getHeight();
        // the overlay is in VIEWER orientation; rotated pages swap dims and
        // need the image rotated back into raw page space
        const vw = (rot === 90 || rot === 270) ? H : W;
        const vh = (rot === 90 || rot === 270) ? W : H;
        const place =
          rot === 90 ? { x: W, y: 0, rotate: degrees(90) } :
          rot === 180 ? { x: W, y: H, rotate: degrees(180) } :
          rot === 270 ? { x: 0, y: H, rotate: degrees(270) } :
          { x: 0, y: 0 };
        page.drawImage(png, { ...place, width: vw, height: vh });
      }
    } else {
      // image doc → single-page PDF: re-encode via canvas (handles jpg/png/webp
      // uniformly), then composite the overlay
      const base = await baseSize(1);
      out = await PDFDocument.create();
      const page = out.addPage([base.width, base.height]);
      const full = await state.doc.renderPage(1, 1);
      const img = await out.embedPng(full.toDataURL('image/png'));
      page.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
      if (pagesWith.has(1)) {
        const png = await out.embedPng(await markupOverlayPng(1));
        page.drawImage(png, { x: 0, y: 0, width: base.width, height: base.height });
      }
    }
    const bytes = await out.save();
    download(new Blob([bytes], { type: 'application/pdf' }), safeName() + '-marked.pdf');
    setMsg('Marked-up PDF downloaded — markups are burned in; print it from any PDF viewer.');
  } catch (e) {
    console.error(e);
    setMsg('Could not build the PDF: ' + e.message);
  }
}

function exportCsv() {
  if (!state.markups.length) { setMsg('No markups yet — nothing to summarize.'); return; }
  const q = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const rows = [['Sheet', 'Type', 'Text / label', 'Value', 'Color', 'Created'].map(q).join(',')];
  const sorted = [...state.markups].sort((a, b) => a.page - b.page || (a.created || 0) - (b.created || 0));
  for (const m of sorted) {
    const isMeasure = m.kind === 'mlength' || m.kind === 'marea' || m.kind === 'mcount';
    rows.push([
      m.page,
      MK_LABEL[m.kind] || m.kind,
      m.text || '',
      isMeasure ? measureValue(m) : '',
      m.color || '',
      m.created ? new Date(m.created).toLocaleString() : '',
    ].map(q).join(','));
  }
  download(new Blob([rows.join('\r\n')], { type: 'text/csv' }), safeName() + '-markups.csv');
  setMsg('Markup summary CSV downloaded.');
}

// open a dropdown rightward, but flip it leftward if that would run off-screen
function openMenu(menu) {
  menu.classList.remove('hidden', 'menu-left');
  if (menu.getBoundingClientRect().right > window.innerWidth - 8) menu.classList.add('menu-left');
}

// Export dropdown
const exportMenu = $('exportMenu');
$('btnExportMenu').addEventListener('click', e => {
  e.stopPropagation();
  if (exportMenu.classList.contains('hidden')) openMenu(exportMenu); else exportMenu.classList.add('hidden');
});
exportMenu.addEventListener('click', e => {
  const item = e.target.closest('[data-act]');
  if (!item) return;
  exportMenu.classList.add('hidden');
  if (item.dataset.act === 'pdf') exportFlatPdf();
  else if (item.dataset.act === 'csv') exportCsv();
});
document.addEventListener('click', e => {
  if (!exportMenu.classList.contains('hidden') && !e.target.closest('.menu-wrap')) exportMenu.classList.add('hidden');
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') exportMenu.classList.add('hidden'); });

// mobile toolbar toggle — show/hide everything after Save
$('btnMenuToggle').addEventListener('click', () => {
  const closed = document.body.classList.toggle('tb-menu-closed'); // shown by default
  $('btnMenuToggle').setAttribute('aria-expanded', closed ? 'false' : 'true');
  $('btnMenuToggle').classList.toggle('primary', closed); // highlight when the toolbar is hidden
});

// Layers dropdown — show/hide markup categories
const layersMenu = $('layersMenu');
$('btnLayers').addEventListener('click', e => {
  e.stopPropagation();
  if (layersMenu.classList.contains('hidden')) openMenu(layersMenu); else layersMenu.classList.add('hidden');
});
layersMenu.querySelectorAll('input[data-layer]').forEach(inp => inp.addEventListener('change', () => {
  layers[inp.dataset.layer] = inp.checked;
  $('btnLayers').classList.toggle('primary', Object.values(layers).some(v => !v)); // highlight when something's hidden
  vp.requestDraw();
}));
document.addEventListener('click', e => {
  if (!layersMenu.classList.contains('hidden') && !e.target.closest('.menu-wrap')) layersMenu.classList.add('hidden');
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') layersMenu.classList.add('hidden'); });

/* ===================== Company library (server-backed) =====================
 * Shares this project — plans, markups, measurements — to the company library
 * (the shared /api/takeoffs route, rows marked data.app='plan-room'). Big plan
 * sets upload straight to R2 via a presigned PUT (needs bucket CORS), then
 * only the small JSON goes through the API. `version` gives optimistic-
 * concurrency: a stale save 409s so it can't silently overwrite a teammate.
 */

function toolApiBase() { return (localStorage.getItem('tc_api_base') || '') + '/api'; }
// sessionStorage FIRST (matches the main app's api.js): during superadmin
// login-as, the impersonation token lives in sessionStorage while the admin's
// own token stays in localStorage — reading localStorage first would hit the
// wrong company (empty estimates / library).
function toolToken() { return sessionStorage.getItem('tc_token') || localStorage.getItem('tc_token') || ''; }
// opts.timeout (ms) aborts a request that never settles — so a hung backend
// can't freeze the UI waiting on it
function withTimeout(opts) {
  const { timeout, ...rest } = opts;
  if (!timeout) return { rest, done: () => {} };
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeout);
  return { rest: { ...rest, signal: rest.signal || c.signal }, done: () => clearTimeout(t) };
}
async function apiFetch(path, opts = {}) {
  const { rest, done } = withTimeout(opts);
  try {
    return await fetch(toolApiBase() + '/takeoffs' + path, {
      ...rest,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + toolToken(), ...(rest.headers || {}) },
    });
  } finally { done(); }
}
// /api/estimates/* — the bid-workflow bridge (launch from an estimate, push
// pricing back). Same auth as the other tool→backend calls.
async function apiEstimate(path, opts = {}) {
  const { rest, done } = withTimeout(opts);
  try {
    return await fetch(toolApiBase() + '/estimates' + path, {
      ...rest,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + toolToken(), ...(rest.headers || {}) },
    });
  } finally { done(); }
}

// ── AI Jump Start ─────────────────────────────────────────────────────────────
// Render the current page, send it to the vision model, and drop its structured
// draft (counts, rough regions) as markups the estimator reviews. Everything
// lands flagged ai:true in a distinct colour — a jump start, never authoritative.

// ── Text-layer gate ────────────────────────────────────────────────────────────
// Jump Start is only worth showing when it can actually deliver: a vector PDF with
// a real text layer. On a scanned/raster page there's nothing to read reliably, so
// the button stays hidden (set that way in index.html) rather than producing noise.
const pageHasText = new Map(); // pageNum -> bool (cleared when a new doc loads)
async function pageHasTextLayer(p) {
  const pg = p || state.page;
  if (!state.doc || state.doc.kind !== 'pdf' || !state.doc.raw) return false;
  if (pageHasText.has(pg)) return pageHasText.get(pg);
  let has = false;
  try {
    const page = await state.doc.raw.getPage(pg);
    const tc = await page.getTextContent();
    has = (tc.items || []).some(it => (it.str || '').trim().length > 0);
  } catch (_) { has = false; }
  pageHasText.set(pg, has);
  return has;
}
async function updateJumpStartVisibility() {
  const btn = $('btnJumpStart');
  if (!btn) return;
  btn.hidden = !(await pageHasTextLayer(state.page));
}

// ── Earthwork: exact spot grades from the PDF text layer (deterministic) ─────────
// A vector grading PDF carries every spot elevation as real text at an exact
// position — no vision model can match reading it straight from the file. `items`
// are text runs in base-px page space: [{ str, x, y }]. Pure + self-contained so it
// is unit-tested by lifting (tests/earthworkSpots.test.js).
//
// Only elevations with a disposition SIGNAL are placed — (parens)/EG = existing,
// FS/FG/GB/TP = proposed — so bearings, dimensions and slopes ("185.00", "1.0%",
// "100.14'") aren't mistaken for grades. Structure/floor elevations (TG/FL/FF/LIP…)
// are reported but skipped: they aren't a ground surface for cut/fill.
function parseEarthworkSpots(items) {
  const ELEV = /\(?\b(\d{2,4}\.\d{1,2})\b\)?/;
  const TAG = /\b(FFE|FS|FG|GB|TP|EG|EX|ME|TG|FL|LIP|HP|TC|TW|BW|INV|RIM|FF)\b/;
  const GRADE = { FS: 'proposed', FG: 'proposed', GB: 'proposed', TP: 'proposed', EG: 'existing', EX: 'existing', ME: 'existing' };
  const STRUCT = { FFE: 1, FF: 1, TG: 1, FL: 1, LIP: 1, HP: 1, TC: 1, TW: 1, BW: 1, INV: 1, RIM: 1 };
  const BAD = /[%°"'=]|\bdia\b/i; // slopes, bearings, feet/inch dims, scale, drywell size

  const runs = (Array.isArray(items) ? items : [])
    .map(it => ({ str: ((it && it.str) || '').trim(), x: Number(it && it.x), y: Number(it && it.y) }))
    .filter(it => it.str && Number.isFinite(it.x) && Number.isFinite(it.y));

  const RADIUS2 = 50 * 50; // base px; a tag sits within ~a line of its number
  const tagNear = (x, y) => {
    let best = null, bd = RADIUS2;
    for (const r of runs) {
      const m = r.str.match(TAG);
      if (!m) continue;
      const dx = r.x - x, dy = r.y - y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = m[1]; }
    }
    return best;
  };

  const spots = [], skipped = [];
  let ambiguous = 0;
  const seen = {};
  for (const r of runs) {
    const m = r.str.match(ELEV);
    if (!m) continue;
    const elev = parseFloat(m[1]);
    if (!Number.isFinite(elev)) continue;
    const key = Math.round(r.x) + ',' + Math.round(r.y) + ',' + m[1];
    if (seen[key]) continue;
    seen[key] = 1;
    const paren = /\(\s*\d{2,4}\.\d{1,2}\s*\)/.test(r.str);
    const self = r.str.match(TAG);
    const tag = (self && self[1]) || tagNear(r.x, r.y);
    // A grade signal (parens or an FS/FG/EG tag) wins — keep it even if a slope like
    // "8.0%" happens to share the run. Only untagged numbers get the bearing/dim/slope
    // filter, so "185.00"/"1.0%"/"100.14'" aren't mistaken for grades.
    if (paren || (tag && GRADE[tag])) spots.push({ elev, surface: paren ? 'existing' : GRADE[tag], tag: tag || null, at: { x: r.x, y: r.y } });
    else if (BAD.test(r.str)) continue;
    else if (tag && STRUCT[tag]) skipped.push({ elev, tag, at: { x: r.x, y: r.y } });
    else ambiguous++;
  }
  return { spots, skipped, ambiguous };
}

// Walk a pdf.js operator list and pull out every stroked/filled polyline in base-px
// page space. `OPS` is pdfjsLib.OPS (passed in so this is pure + unit-testable);
// `base` is the scale-1 viewport.transform (the initial CTM). We track the CTM stack
// (save/restore/transform) exactly as the renderer would, so coordinates land where
// they draw. Bézier segments are approximated by their endpoints — fine for spotting
// contour lines; we're not re-rendering. Contours arrive here mixed in with every
// other line on the sheet (buildings, dims, and the vector spot-grade text); the
// caller filters by length.
function extractPdfPolylines(opList, OPS, base) {
  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  const apply = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
  let ctm = base.slice();
  const stack = [];
  const out = [];
  let cur = null;
  const flush = () => { if (cur && cur.length >= 2) out.push(cur); cur = null; };
  const fn = opList.fnArray || [], args = opList.argsArray || [];
  for (let i = 0; i < fn.length; i++) {
    const op = fn[i];
    if (op === OPS.save) stack.push(ctm.slice());
    else if (op === OPS.restore) { ctm = stack.pop() || ctm; }
    else if (op === OPS.transform) ctm = mul(ctm, args[i]);
    else if (op === OPS.constructPath) {
      const a = args[i] || [];
      const sub = a[0] || [], co = a[1] || [];
      let j = 0;
      for (let k = 0; k < sub.length; k++) {
        const s = sub[k];
        if (s === OPS.moveTo) { flush(); cur = [apply(ctm, co[j], co[j + 1])]; j += 2; }
        else if (s === OPS.lineTo) { if (!cur) cur = []; cur.push(apply(ctm, co[j], co[j + 1])); j += 2; }
        else if (s === OPS.curveTo) { if (!cur) cur = []; cur.push(apply(ctm, co[j + 4], co[j + 5])); j += 6; }
        else if (s === OPS.curveTo2 || s === OPS.curveTo3) { if (!cur) cur = []; cur.push(apply(ctm, co[j + 2], co[j + 3])); j += 4; }
        else if (s === OPS.rectangle) {
          const x = co[j], y = co[j + 1], w = co[j + 2], h = co[j + 3]; j += 4;
          flush(); cur = [apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x + w, y + h), apply(ctm, x, y + h), apply(ctm, x, y)]; flush();
        } else if (s === OPS.closePath) { if (cur && cur.length) cur.push(cur[0]); }
      }
      flush();
    }
  }
  flush();
  return out;
}

// Bounding-box diagonal of a polyline (base px) — the cheap "how big is this line"
// used to separate sheet-spanning contours from glyph-sized and dimension linework.
function polyDiag(pts) {
  if (!pts || !pts.length) return 0;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const p of pts) { if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x; if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y; }
  return Math.hypot(maxx - minx, maxy - miny);
}

// Pull spot grades from the current page's PDF text layer and place them as espot
// markups. Deterministic — no server, no AI, no metering.
// Drop a polyline to at most `max` vertices (keeps the ends) so a 3000-point contour
// doesn't bloat the markup store — the shape survives, the weight doesn't.
function decimate(pts, max) {
  if (!pts || pts.length <= max) return pts;
  const out = [], step = pts.length / max;
  for (let i = 0; i < pts.length; i += step) out.push(pts[Math.floor(i)]);
  const last = pts[pts.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

// Earthwork extraction, ITERATION 1 (contours). The spot grades on these sheets are
// vector/SHX line-work, not text — but the contour lines are real geometry and the
// contour ELEVATIONS are real text. So: pull every polyline from the page, keep the
// sheet-spanning ones as candidate contours, label each from the nearest integer, and
// place them for review. Also grabs any text spot grades (cheap; usually none here).
// Classification is deliberately loose — this is a first pass to eyeball, not final.
async function runContourExtract() {
  const btn = $('btnJumpStart');
  try {
    if (btn) btn.disabled = true;
    setMsg('Extracting contours from the PDF…');
    const page = await state.doc.raw.getPage(state.page);
    const vp = page.getViewport({ scale: 1 }); // base-px space (matches baseSize / markup coords)
    const OPS = pdfjsLib.OPS;
    const [opList, tc] = await Promise.all([page.getOperatorList(), page.getTextContent()]);
    const items = (tc.items || []).map(it => {
      const p = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
      return { str: (it.str || '').trim(), x: p[0], y: p[1] };
    });

    // Vector polylines → sheet-spanning candidates (contours vs. glyph/dimension noise).
    const sheetDiag = Math.hypot(vp.width, vp.height);
    const all = extractPdfPolylines(opList, OPS, vp.transform);
    let cand = all.filter(pl => pl.length >= 3 && polyDiag(pl) > sheetDiag * 0.08);
    cand.sort((a, b) => polyDiag(b) - polyDiag(a));
    if (cand.length > 800) cand = cand.slice(0, 800); // keep the longest

    // Integer contour labels (e.g. 305, 312) placed on/near the lines.
    const labels = items
      .map(l => ({ x: l.x, y: l.y, elev: /^\d{2,4}$/.test(l.str) ? parseInt(l.str, 10) : null }))
      .filter(l => l.elev != null && l.elev >= 50 && l.elev <= 9999);
    const labelFor = (pts) => {
      let best = null, bd = (sheetDiag * 0.04) ** 2;
      const step = Math.max(1, Math.floor(pts.length / 40)); // sample vertices for speed
      for (const L of labels) {
        for (let i = 0; i < pts.length; i += step) {
          const dx = L.x - pts[i].x, dy = L.y - pts[i].y, d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = L.elev; }
        }
      }
      return best;
    };

    const now = Date.now();
    const rid = () => 'ai' + Math.random().toString(36).slice(2, 10);
    let labeled = 0;
    const marks = cand.map(pts => {
      const elev = labelFor(pts);
      if (elev != null) labeled++;
      return { id: rid(), page: state.page, kind: 'contour', color: '#9333ea', width: 2, pts: decimate(pts, 300), elev, surface: curSurface, ai: true, extracted: true, aiConfidence: 'low', created: now };
    });

    // Any text spot grades too (harmless when there are none).
    const { spots } = parseEarthworkSpots(items);
    for (const s of spots) marks.push({ id: rid(), page: state.page, kind: 'espot', color: '#9333ea', width: 2, pts: [{ x: s.at.x, y: s.at.y }], elev: s.elev, surface: s.surface === 'proposed' || s.surface === 'existing' ? s.surface : curSurface, ai: true, extracted: true, aiConfidence: 'high', created: now });

    try { console.log('[JumpStart contours] polylines:', all.length, 'candidates:', cand.length, 'labeled:', labeled, 'int-labels:', labels.length, 'spots:', spots.length); } catch (_) { /* no console */ }

    if (!marks.length) {
      const msg = `No sheet-spanning lines or spot grades found to extract (${all.length} polylines on the page, none long enough to be a contour). If the contours are raster/scanned rather than vector, they can't be pulled from the file.`;
      setMsg('Contour extract: ' + msg);
      alert('Earthwork contour extract — nothing placed\n\n' + msg);
      return;
    }
    const prev = snapshot();
    state.markups.push(...marks);
    pushUndo(prev);
    markupsChanged();
    const diag = `Extracted ${cand.length} candidate contour line${cand.length === 1 ? '' : 's'} (${labeled} auto-labeled with an elevation)${spots.length ? ` and ${spots.length} spot grade${spots.length === 1 ? '' : 's'}` : ''}, all on the ${curSurface} surface. ITERATION 1 — verify which are really contours (delete buildings/dimensions it grabbed), fix any wrong elevations, then set the other surface and run cut/fill. Undo removes them all at once.`;
    setMsg('Contour extract: ' + diag);
    alert('Earthwork contour extract\n\n' + diag);
  } catch (e) {
    setMsg('Contour extraction failed: ' + (e && e.message ? e.message : e));
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Structured model result → Plan Room markups. Coordinates arrive NORMALIZED
// [0,1] of the page image; dims is the page's base-px size, so normalized × dims
// = base px (the markup coordinate space). Pure, so it's unit-tested by lifting.
function jumpstartToMarkups(result, page, dims, opts) {
  const o = opts || {};
  const r = result || {};
  const w = dims && dims.w, h = dims && dims.h;
  if (!(w > 0 && h > 0)) return [];
  const trade = o.trade || '';
  const defSurface = o.curSurface === 'proposed' ? 'proposed' : 'existing';
  const rid = () => 'ai' + Math.random().toString(36).slice(2, 10);
  const now = Date.now();
  const den = p => ({ x: p.x * w, y: p.y * h });
  const out = [];

  for (const c of Array.isArray(r.counts) ? r.counts : []) {
    const pts = (Array.isArray(c.points) ? c.points : []).map(den);
    if (!pts.length) continue;
    out.push({
      id: rid(), page, kind: 'qcount', color: '#9333ea', width: 2, pts,
      cfg: { label: c.label || 'Item', unit: c.unit || 'EA' },
      ai: true, aiConfidence: c.confidence || 'low', created: now,
    });
  }
  for (const rg of Array.isArray(r.regions) ? r.regions : []) {
    const pts = (Array.isArray(rg.polygon) ? rg.polygon : []).map(den);
    if (pts.length < 3) continue;
    // In earthwork, a "limits of disturbance" region is the cut/fill boundary, not a
    // generic area takeoff — place it as an ebound so it drives the grid.
    const isLimits = trade === 'dirt' && /limit|disturb|grading/i.test(rg.label || '');
    out.push(isLimits
      ? { id: rid(), page, kind: 'ebound', pts, ai: true, aiConfidence: rg.confidence || 'low', created: now }
      : { id: rid(), page, kind: 'qarea', pts, cfg: { label: rg.label || 'Area' }, ai: true, aiConfidence: rg.confidence || 'low', created: now });
  }
  // Earthwork spot elevations → espot markups on the surface the model guessed
  // (falling back to the surface the estimator is currently working).
  for (const s of Array.isArray(r.spots) ? r.spots : []) {
    if (!s || !s.at || s.elev == null) continue;
    const surface = (s.surface === 'existing' || s.surface === 'proposed') ? s.surface : defSurface;
    out.push({
      id: rid(), page, kind: 'espot', color: '#9333ea', width: 2, pts: [den(s.at)],
      elev: Number(s.elev), surface, ai: true, aiConfidence: 'low', created: now,
    });
  }
  return out;
}

// Vision is slow (30–120s) so this uses a plain fetch, no short timeout wrapper.
async function apiJump(path, opts = {}) {
  return fetch(toolApiBase() + '/jumpstart' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + toolToken(), ...(opts.headers || {}) },
  });
}

async function runJumpStart() {
  if (!state.doc || !state.page) { setMsg('Open a plan first.'); return; }
  // Earthwork pulls contour geometry (and any text spot grades) straight from the PDF —
  // deterministic, no AI. (The button only shows on a real PDF, so raw is available.)
  if (state.trade === 'dirt') return runContourExtract();
  const btn = $('btnJumpStart');
  // A/B knob: set localStorage.jumpstart_provider = 'gemini' to compare providers
  // on the same sheet. Absent → the server default (Anthropic/Opus).
  const provider = localStorage.getItem('jumpstart_provider') || undefined;
  try {
    if (btn) btn.disabled = true;
    setMsg('AI Jump Start — reading this page…');
    const base = pageBase.get(state.page) || await state.doc.baseSize(state.page);
    // Cap the long edge ~1600px: detail enough for the model, not wasteful — the
    // provider downscales anyway, and bigger just burns tokens.
    const scale = Math.min(2, 1600 / Math.max(base.width, base.height));
    const canvas = await state.doc.renderPage(state.page, scale);
    const dataUrl = canvas.toDataURL('image/png');
    const imageBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);

    // Tell the model which trade we're working so it targets the right quantities
    // (a generic scan is why earthwork used to come back as a tree-count blob).
    const trade = state.trade || '';
    const res = await apiJump('/page', { method: 'POST', body: JSON.stringify({ imageBase64, mediaType: 'image/png', provider, trade }) });
    if (res.status === 429) { setMsg('AI limit reached for this month.'); return; }
    if (res.status === 503) { setMsg('AI Jump Start isn’t configured yet (missing API key).'); return; }
    if (res.status === 413) { setMsg('This page is too large to send. Try a smaller sheet.'); return; }
    if (!res.ok) { setMsg('AI Jump Start failed — please try again.'); return; }
    const { result } = await res.json();

    const markups = jumpstartToMarkups(result, state.page, { w: base.width, h: base.height }, { trade, curSurface });
    if (markups.length) {
      const prev = snapshot();
      state.markups.push(...markups);
      pushUndo(prev);
      markupsChanged();
    }
    jumpStartSummary(result, markups.length);
  } catch (e) {
    setMsg('AI Jump Start error: ' + (e && e.message ? e.message : e));
  } finally {
    if (btn) btn.disabled = false;
  }
}

function jumpStartSummary(result, placed) {
  const r = result || {};
  const counts = (r.counts || []).map(c => `${c.points.length} ${c.label}`).join(', ');
  const spotN = (r.spots || []).length;
  const scaleLine = r.scale && r.scale.found
    ? `Scale read: ${r.scale.text || (r.scale.feetPerInch + ' ft/in')} — this is a suggestion; confirm it by drawing your scale bar.`
    : 'No scale found on this sheet — set it manually.';

  // Earthwork verdict — the honest headline when cut/fill can't be computed from this
  // sheet (e.g. an existing-conditions sheet with no proposed grade). This replaces the
  // old behaviour of drawing a meaningless clearing blob.
  const ew = r.earthwork;
  let ewLine = '';
  if (ew) {
    if (ew.cutFillComputable) {
      ewLine = `Earthwork: this sheet shows ${ew.existingContours ? 'existing' : 'no existing'} and proposed grade — cut/fill can be computed. Trace/confirm contours and the disturbance boundary, then run the cut/fill.`;
    } else {
      ewLine = `⚠ Earthwork: cut/fill can’t be computed from this sheet — ${ew.reason || 'it shows existing grade only, with no proposed (finished) grade to difference against.'} Run Jump Start on the grading/proposed sheet, or add the proposed surface, to get cut/fill.`;
    }
  }

  const headline = ewLine && !ew.cutFillComputable
    ? ewLine
    : (placed
      ? `Drafted ${placed} AI markup${placed === 1 ? '' : 's'} (shown in purple). These are a first draft — review, edit, and delete what's wrong before trusting the quantities.`
      : 'Nothing confidently markable on this page.');

  const lines = [
    headline,
    ewLine && ewLine !== headline ? ewLine : '',
    spotN ? `Read ${spotN} spot elevation${spotN === 1 ? '' : 's'} — placed on the ${curSurface} surface; re-tag any that belong to the other surface, and correct any misreads.` : '',
    counts && `Counts: ${counts}.`,
    (r.regions || []).length ? `${(r.regions || []).length} rough region(s) — reshape the vertices.` : '',
    scaleLine,
    r.notes ? `AI notes: ${r.notes}` : '',
  ].filter(Boolean);
  setMsg(lines[0]);
  alert('AI Jump Start\n\n' + lines.join('\n\n'));
}

// Show status inside the Company modal (visible over the dialog) and the HUD.
function companyMsg(t, isError) {
  const el = $('companyMsg');
  if (el) { el.textContent = t || ''; el.style.color = isError ? '#f87171' : ''; }
  setMsg(t);
}

const UPLOAD_MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
function docExt() {
  const m = /\.(pdf|png|jpe?g|webp)$/i.exec(state.docName || '');
  if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
  const t = state.docType || '';
  if (t.includes('png')) return 'png';
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  if (t.includes('webp')) return 'webp';
  return 'pdf';
}

// Presigned three-step: URL from the API → browser PUTs bytes straight to R2
// → the create call carries only the resulting publicUrl.
async function uploadDocToR2() {
  if (!state.docKey) return null;
  const f = await store.filesGet(state.docKey);
  if (!f || !f.bytes) return null;
  const ext = docExt();
  const ur = await apiFetch('/upload-url', { method: 'POST', body: JSON.stringify({ ext }) });
  if (!ur.ok) throw new Error('HTTP ' + ur.status + ' (upload-url)');
  const { uploadUrl, publicUrl } = await ur.json();
  companyMsg('Uploading the plans…');
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    body: f.bytes,
    headers: { 'Content-Type': UPLOAD_MIME[ext] }, // must match the presigned signature
  });
  if (!put.ok) throw new Error('HTTP ' + put.status + ' (R2 upload — is bucket CORS configured?)');
  return publicUrl;
}

async function shareToCompany({ overwrite = false } = {}) {
  if (!state.doc && !state.markups.length) {
    companyMsg('Nothing to share yet — open a plan set first.', true);
    return;
  }
  const name = state.projectName || 'Plan set';
  companyMsg('Sharing…');
  try {
    if (state.serverId) {
      const res = await apiFetch('/' + state.serverId, {
        method: 'PUT', body: JSON.stringify({ name, data: projectData(), version: state.serverVersion, overwrite }),
      });
      if (res.status === 423) {
        const j = await res.json().catch(() => ({}));
        companyMsg(`🔒 Locked by ${j.lockedByName || 'a teammate'} — ask them or an admin to unlock (in ☁ Company), or use “Copy to my projects” to work separately.`, true);
        return;
      }
      if (res.status === 409) { return shareConflict(await res.json()); }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      state.serverVersion = (await res.json()).version;
      companyMsg('Saved to the company copy — teammates will see your changes.');
    } else {
      const pdfUrl = await uploadDocToR2();
      const res = await apiFetch('', {
        method: 'POST',
        body: JSON.stringify({ name, data: projectData(), pdfUrl, pdfName: state.docName }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const out = await res.json();
      state.serverId = out.id; state.serverVersion = out.version;
      companyMsg('Shared to the company. Teammates can copy it from ☁ Company.');
    }
    if (!$('company').classList.contains('hidden')) refreshCompanyList();
  } catch (e) {
    companyMsg('Could not share (are you signed in to OpsFloa?): ' + e.message, true);
  }
}

async function shareConflict(c) {
  const who = esc(c.updatedByName || 'A teammate');
  const choice = await askChoice(
    'Someone else changed this shared takeoff',
    `${who} saved changes since you opened it (now v${c.currentVersion}). What do you want to do?`,
    [
      { label: '📑 Keep both — save mine as a new, separate copy', value: 'fork', primary: true },
      { label: '⚠ Overwrite theirs with my version (discards their changes)', value: 'overwrite', danger: true },
      { label: 'Cancel — leave theirs, keep editing locally', value: null },
    ]);
  if (choice === 'fork') { state.serverId = null; state.serverVersion = null; return shareToCompany(); }
  if (choice === 'overwrite') { return shareToCompany({ overwrite: true }); }
  companyMsg('Left the shared copy as theirs — your work is still saved locally.');
}

async function refreshCompanyList() {
  const list = $('companyList');
  list.innerHTML = '<div class="hint">Loading…</div>';
  // load both concurrently with hard timeouts — the (optional) live-sessions
  // lookup must never block or hang the primary shared-projects list
  const [liveR, sharedR] = await Promise.allSettled([
    apiLive('?tool=planroom', { timeout: 8000 }).then(r => (r.ok ? r.json() : [])),
    apiFetch('?app=plan-room', { timeout: 12000 }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
  ]);
  const live = liveR.status === 'fulfilled' && Array.isArray(liveR.value) ? liveR.value : [];
  if (sharedR.status === 'rejected') {
    const why = sharedR.reason && sharedR.reason.name === 'AbortError' ? 'timed out' : (sharedR.reason && sharedR.reason.message) || 'failed';
    list.innerHTML = `<div class="hint">Could not load the company library (${esc(why)}). Make sure you're signed in to OpsFloa, then reopen this.</div>`;
    return;
  }
  const rows = Array.isArray(sharedR.value) ? sharedR.value : [];
  {
    list.innerHTML = '';
    // live sessions first — join to co-edit in real time
    for (const s of live) {
      const mine = session && String(session.id) === String(s.id);
      const row = document.createElement('div');
      row.className = 'proj-row';
      // host/admin can close any lingering session straight from the list
      const endBtn = s.can_end ? '<button class="btn tiny" data-act="end-live" title="Close this session for everyone">End</button>' : '';
      row.innerHTML =
        `<div class="grow"><div class="name"></div>` +
        `<div class="meta"><span class="pill" style="background:var(--good);color:#062915">LIVE</span> ${s.host_name ? 'by ' + esc(s.host_name) + ' · ' : ''}${s.participants || 0} here</div></div>` +
        endBtn +
        (mine ? '<span class="pill">in this</span>' : '<button class="btn tiny primary" data-act="join">Join live</button>');
      row.querySelector('.name').textContent = s.name || 'Live session';
      const jb = row.querySelector('[data-act="join"]');
      if (jb) jb.addEventListener('click', () => joinSession(s.id));
      const eb = row.querySelector('[data-act="end-live"]');
      if (eb) eb.addEventListener('click', () => endSessionFromList(s.id));
      list.appendChild(row);
    }
    if (!rows.length && !live.length) {
      list.innerHTML = '<div class="hint">No shared plan sets or live co-edit sessions yet. Open a set and hit “Share current project”, or 🟢 Live Co-Edit.</div>';
      return;
    }
    for (const r of rows) {
      const when = r.updated_at ? new Date(r.updated_at).toLocaleString() : '';
      const locked = !!r.locked_by;
      const lockBadge = locked ? ` · <span class="pill" style="background:var(--warn);color:#3a2a00">🔒 ${esc(r.locked_by_name || 'locked')}</span>` : '';
      const lockBtn = `<button class="btn tiny" data-act="${locked ? 'unlock' : 'lock'}" title="${locked ? 'Release the lock (the holder or any admin can)' : 'Reserve this — teammates can’t save over it while it’s locked'}">${locked ? '🔓' : '🔒'}</button>`;
      const row = document.createElement('div');
      row.className = 'proj-row' + (String(r.id) === String(state.serverId) ? ' current' : '');
      row.innerHTML =
        `<div class="grow"><div class="name"></div>` +
        `<div class="meta">${r.pdf_name ? esc(r.pdf_name) + ' · ' : ''}v${r.version}${r.updated_by_name ? ' · by ' + esc(r.updated_by_name) : ''} · ${when}${lockBadge}</div></div>` +
        lockBtn +
        (String(r.id) === String(state.serverId)
          ? '<span class="pill">current</span>'
          : '<button class="btn tiny" data-act="copy">Copy to my projects</button>') +
        '<button class="btn tiny danger" data-act="del" title="Delete this shared project">✕</button>';
      row.querySelector('.name').textContent = r.name;
      const copyBtn = row.querySelector('[data-act="copy"]');
      if (copyBtn) copyBtn.addEventListener('click', () => copyCompanyProject(r.id));
      const lkBtn = row.querySelector('[data-act="lock"]');
      if (lkBtn) lkBtn.addEventListener('click', () => lockShared(r.id, true));
      const unBtn = row.querySelector('[data-act="unlock"]');
      if (unBtn) unBtn.addEventListener('click', () => lockShared(r.id, false));
      row.querySelector('[data-act="del"]').addEventListener('click', () => deleteCompanyShared(r.id, r.name));
      list.appendChild(row);
    }
  }
}

async function lockShared(id, lock) {
  try {
    const res = await apiFetch('/' + id + '/' + (lock ? 'lock' : 'unlock'), { method: 'POST' });
    if (res.status === 409) { const j = await res.json().catch(() => ({})); companyMsg(`Already locked by ${j.lockedByName || 'a teammate'}.`, true); return; }
    if (res.status === 403) { companyMsg('Only the person who locked it or an admin can unlock it.', true); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    companyMsg(lock ? 'Locked — teammates can’t save over it until it’s unlocked.' : 'Unlocked.');
    refreshCompanyList();
  } catch (e) { companyMsg('Could not change the lock: ' + e.message, true); }
}

async function copyCompanyProject(id) {
  let t;
  try {
    const res = await apiFetch('/' + id);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    t = await res.json();
  } catch (e) { companyMsg('Could not reach that shared project: ' + e.message, true); return; }
  if (!t.data || t.data.app !== 'plan-room') { companyMsg('That shared project could not be read.', true); return; }

  // How should it land locally? (name field first — askModal returns it; the
  // radio choice is read from the modal body afterward, which persists.)
  const nameAttr = String(t.name || 'Plan set').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const name = await modals.askModal({
    title: 'Copy to my projects',
    body: `
      <input type="text" id="modalTxt" maxlength="80" value="${nameAttr}">
      <label style="display:block;margin:8px 0 0"><input type="radio" name="cpmode" value="new" checked> Save as a new project</label>
      <label style="display:block;margin:4px 0 0"><input type="radio" name="cpmode" value="over"> Overwrite the project I have open now</label>
      <div class="hint">Pulls the shared set — plans, markups, and measurements — into your projects on this device.</div>`,
    focusSel: '#modalTxt',
  });
  if (name === null) { companyMsg(''); return; }
  const overwrite = !!$('modalBody').querySelector('input[name="cpmode"][value="over"]:checked');
  const finalName = String(name).trim() || t.name || 'Plan set';

  companyMsg('Copying from the company library…');
  try {
    await saveProjectNow(); // flush the outgoing project first
    if (!overwrite) state.projectId = randId();
    state.projectName = finalName;
    const keepId = state.projectId;
    resetDocState();
    state.projectId = keepId;
    state.markups = Array.isArray(t.data.markups) ? t.data.markups : [];
    state.scales = t.data.scales || {};
    state.scaleBars = t.data.scaleBars || {};
    if (t.data.roofPitch != null) state.roofPitch = t.data.roofPitch;
    if (t.data.roofWaste != null) state.roofWaste = t.data.roofWaste;
    state.roofPrices = t.data.roofPrices || {};
    if (t.data.roofOP != null) state.roofOP = t.data.roofOP;
    state.earthwork = t.data.earthwork || defaultEarthwork();
    state.trade = t.data.trade || '';
    state.bidMeta = t.data.bidMeta || {};
    state.drywall = t.data.drywall || defaultDrywall();
    state.flooring = t.data.flooring || defaultFlooring();
    state.framing = t.data.framing || defaultFraming();
    state.esc = t.data.esc || defaultEsc();
    state.striping = t.data.striping || defaultStriping();
    state.siding = t.data.siding || defaultSiding();
    state.demo = t.data.demo || defaultDemo();
    state.fence = t.data.fence || defaultFence();
    state.landscape = t.data.landscape || defaultLandscape();
    state.estimateId = t.data.estimateId || null;
    renderMarkupList(); syncRoofInputs(); syncDirtInputs(); syncDwInputs(); syncTradeUI();
    try { localStorage.setItem('planroom-current', state.projectId); } catch (_) {}
    updateProjectBtn();
    if (t.pdf_url) {
      const pres = await apiFetch('/' + id + '/pdf'); // doc proxied through the API (no R2 CORS needed to read)
      if (!pres.ok) throw new Error('HTTP ' + pres.status + ' (plans download)');
      const pj = await pres.json();
      await openFromBytes(base64ToBytes(pj.b64).buffer, pj.name || t.pdf_name || 'plans.pdf', t.data.docType);
      if (t.data.page) await setPage(t.data.page);
    }
    state.serverId = t.id; state.serverVersion = t.version;
    scheduleSave(true);
    $('company').classList.add('hidden');
    companyMsg(overwrite ? `Overwrote your open project with “${finalName}”.` : `Copied “${finalName}” into your projects.`);
  } catch (e) { companyMsg('Could not copy that shared project: ' + e.message, true); }
}

async function deleteCompanyShared(id, name) {
  const ok = await modals.askModal({
    title: `Delete the shared “${name}”?`,
    body: '<div class="hint">Removes it from the company library for everyone. Local copies people already made are not affected. This cannot be undone.</div>',
  });
  if (ok === null) return;
  try {
    const res = await apiFetch('/' + id, { method: 'DELETE' });
    if (res.status === 403) { companyMsg('Only the person who shared it (or an admin) can delete it.', true); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (String(id) === String(state.serverId)) { state.serverId = null; state.serverVersion = null; }
    refreshCompanyList();
    companyMsg('Shared project deleted.');
  } catch (e) { companyMsg('Could not delete: ' + e.message, true); }
}

function openCompany() {
  // Show the signed-in company's name in the header (bridged to localStorage by
  // the React app's AuthContext), so it's clear whose library you're sharing to.
  let cn = ''; try { cn = localStorage.getItem('tc_company') || ''; } catch { /* blocked */ }
  $('companyTitle').textContent = cn ? `${cn} — Company library` : 'Company library';
  $('company').classList.remove('hidden');
  companyMsg('');
  refreshCompanyList();
}
$('btnCompany').addEventListener('click', openCompany);
$('companyShareBtn').addEventListener('click', shareToCompany);
$('companyClose').addEventListener('click', () => $('company').classList.add('hidden'));
$('company').addEventListener('click', e => { if (e.target === $('company')) $('company').classList.add('hidden'); });

/* ===================== Sitework quantity takeoffs — Area (Q1) =====================
 * Copied from sitework/app.js (see shared/PARITY.md). A qarea markup is a
 * polygon + a cfg {label,mode,thickness,density,rebar,form,tack,swell,respread,
 * deduct,color}; area/perimeter recompute live from geometry × the sheet scale.
 */

const AREA_PRESETS = {
  asphalt:  { label: 'Asphalt paving', mode: 'paving', thickness: 3, density: 145, tack: 0.10 },
  base:     { label: 'Aggregate base', mode: 'tons', thickness: 6, density: 135 },
  concrete: { label: 'Concrete flatwork', mode: 'concrete', thickness: 4, rebar: '#4@18', form: true },
  gravel:   { label: 'Gravel / fill', mode: 'cy', thickness: 6 },
  topsoil:  { label: 'Topsoil strip', mode: 'strip', thickness: 6, swell: 25, respread: 0 },
  areaonly: { label: 'Area', mode: 'area' },
};
const AREA_MODE_COLORS = { concrete: '#9aa7b8', paving: '#5b6472', tons: '#c7a55f', cy: '#b07d43', strip: '#6fae4d' };
const AREA_PALETTE = ['#38d39f', '#4da3ff', '#c07ef7', '#e0912b', '#e05555', '#2bb3c0', '#d24d8c', '#8bbf3f'];
function autoAreaColor(mode, label) {
  const m = AREA_MODE_COLORS[mode];
  if (m) return m;
  const s = String(label || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AREA_PALETTE[h % AREA_PALETTE.length];
}
const areaColorHex = cfg => (cfg && cfg.color) || autoAreaColor(cfg.mode, cfg.label);

const REBAR = {
  '#4@18': { bar: '#4', spacing: '18', sp: 1.5, lb: 0.668 },
  '#4@12': { bar: '#4', spacing: '12', sp: 1.0, lb: 0.668 },
  '#5@12': { bar: '#5', spacing: '12', sp: 1.0, lb: 1.043 },
};
function rebarQuantity(areaSf, key) {
  if (key === 'mesh') return { type: 'mesh', meshSf: areaSf * 1.05 };
  const r = REBAR[key];
  if (!r) return null;
  const lf = 2 * areaSf / r.sp * 1.10; // both directions + 10% laps/waste
  return { type: r.bar, spacing: r.spacing, lf, weightLb: lf * r.lb };
}
function areaQuantity(areaSf, cfg) {
  const thickFt = (parseFloat(cfg.thickness) || 0) / 12;
  if (cfg.mode === 'tons' || cfg.mode === 'paving') {
    const d = parseFloat(cfg.density) || 145;
    return { quantity: areaSf * thickFt * d / 2000, unit: 'tons' };
  }
  if (cfg.mode === 'cy' || cfg.mode === 'concrete') return { quantity: areaSf * thickFt / 27, unit: 'CY' };
  if (cfg.mode === 'strip') {
    const stripCY = areaSf * thickFt / 27;
    const swell = 1 + (parseFloat(cfg.swell) || 0) / 100;
    const respreadCY = areaSf * ((parseFloat(cfg.respread) || 0) / 12) / 27;
    const netExportCY = Math.max(0, stripCY - respreadCY);
    return { quantity: stripCY, unit: 'CY', stripCY, looseCY: stripCY * swell, respreadCY, netExportCY, netExportLooseCY: netExportCY * swell };
  }
  return { quantity: areaSf, unit: 'SF' };
}
function computeAreaResult(areaSf, cfg, perimFt) {
  const q = areaQuantity(areaSf, cfg);
  const r = { areaSf, sy: areaSf / 9, acres: areaSf / 43560, label: cfg.label, perimFt: perimFt || 0, ...q };
  if (cfg.mode === 'concrete') {
    if (cfg.form !== false && perimFt > 0) r.formworkLF = perimFt;
    const reb = rebarQuantity(areaSf, cfg.rebar);
    if (reb) r.rebar = reb;
  } else if (cfg.mode === 'paving') {
    const rate = parseFloat(cfg.tack);
    const tackRate = isFinite(rate) ? rate : 0.10;
    if (tackRate > 0) r.tackGal = (areaSf / 9) * tackRate;
  }
  return r;
}
function areaResultRows(areaSf, cfg, perimFt) {
  const r = computeAreaResult(areaSf, cfg, perimFt);
  const rows = [['Area', `${fmt(areaSf)} sf · ${fmt(r.sy)} sy · ${fmt(r.acres, 2)} ac`]];
  if (cfg.mode === 'strip') {
    rows.push(['Strip volume', `${fmt(r.stripCY, 1)} CY bank`, 'total']);
    rows.push(['Loose (haul)', `${fmt(r.looseCY, 1)} CY`]);
    if (r.respreadCY > 0) {
      rows.push(['Respread', `${fmt(r.respreadCY, 1)} CY bank`]);
      rows.push(['Net export', `${fmt(r.netExportCY, 1)} CY bank · ${fmt(r.netExportLooseCY, 1)} loose`, 'total']);
    }
  } else if (cfg.mode === 'concrete') {
    rows.push(['Concrete volume', `${fmt(r.quantity, 1)} CY`, 'total']);
    if (r.formworkLF) rows.push(['Edge forms', `${fmt(r.formworkLF)} LF`]);
    if (r.rebar) rows.push(r.rebar.type === 'mesh'
      ? ['Wire mesh', `${fmt(r.rebar.meshSf)} SF`]
      : [`Rebar ${r.rebar.type} @ ${r.rebar.spacing}"`, `${fmt(r.rebar.lf)} LF · ${fmt(r.rebar.weightLb)} lb`]);
  } else if (cfg.mode === 'paving') {
    rows.push(['Asphalt weight', `${fmt(r.quantity, 1)} tons`, 'total']);
    if (r.tackGal) rows.push(['Tack coat', `${fmt(r.tackGal)} gal`]);
  } else if (cfg.mode !== 'area') {
    rows.push([cfg.mode === 'tons' ? 'Weight' : 'Volume', `${fmt(r.quantity, 1)} ${r.unit}`, 'total']);
  }
  return rows.map(([k, v, cls]) => `<div class="res-row ${cls === 'total' ? 'total' : ''}"><span>${k}</span><b>${v}</b></div>`).join('');
}
function readAreaCfg() {
  return {
    label: $('atLabel').value.trim() || 'Area', mode: $('atMode').value,
    thickness: $('atThick').value, density: $('atDensity').value, rebar: $('atRebar').value,
    form: $('atForm').checked, tack: $('atTack').value, swell: $('atSwell').value,
    respread: $('atRespread').value, deduct: $('atDeduct').checked, color: $('atColor').value,
  };
}
function syncAreaMode() {
  const mode = $('atMode').value;
  $('atThickWrap').style.display = mode === 'area' ? 'none' : '';
  $('atDensityWrap').style.display = (mode === 'tons' || mode === 'paving') ? '' : 'none';
  $('atRebarWrap').style.display = mode === 'concrete' ? '' : 'none';
  $('atFormWrap').style.display = mode === 'concrete' ? '' : 'none';
  $('atTackWrap').style.display = mode === 'paving' ? '' : 'none';
  $('atSwellWrap').style.display = mode === 'strip' ? '' : 'none';
  $('atRespreadWrap').style.display = mode === 'strip' ? '' : 'none';
  $('atThickLbl').textContent = mode === 'strip' ? 'Strip depth (in)' : 'Thickness (in)';
}
let lastAreaCfg = null;
// The last area's settings pre-fill the NEXT new area (label, mode, color, …) as a
// convenience. `deduct` is deliberately NOT carried: it's a per-shape property
// (this one shape is a void), so drawing a deduct must not silently make every
// following shape a deduct too. Editing an existing shape pre-fills from that
// shape's own cfg, so its deduct state is preserved there.
const rememberAreaCfg = cfg => { lastAreaCfg = cfg ? { ...cfg, deduct: false } : cfg; };
function askAreaConfig(areaSf, perimFt, prefill) {
  return new Promise(resolve => {
    const preview = () => { $('atResult').innerHTML = areaResultRows(areaSf, readAreaCfg(), perimFt); };
    $('atArea').textContent = `${fmt(areaSf)} sf`;
    $('atDeduct').checked = !!(prefill && prefill.deduct);
    if (prefill) {
      $('atLabel').value = prefill.label != null ? prefill.label : '';
      $('atMode').value = prefill.mode || 'area';
      if (prefill.thickness != null) $('atThick').value = prefill.thickness;
      if (prefill.density != null) $('atDensity').value = prefill.density;
      if (prefill.rebar != null) $('atRebar').value = prefill.rebar;
      if (prefill.form != null) $('atForm').checked = !!prefill.form;
      if (prefill.tack != null) $('atTack').value = prefill.tack;
      if (prefill.swell != null) $('atSwell').value = prefill.swell;
      if (prefill.respread != null) $('atRespread').value = prefill.respread;
    }
    $('atColor').value = (prefill && prefill.color) || autoAreaColor($('atMode').value, $('atLabel').value);
    syncAreaMode();
    preview();
    $('areaTakeoff').classList.remove('hidden');
    const onInput = () => { syncAreaMode(); preview(); };
    const inputs = ['atLabel', 'atMode', 'atThick', 'atDensity', 'atRebar', 'atForm', 'atTack', 'atSwell', 'atRespread'];
    inputs.forEach(id => { $(id).addEventListener('input', onInput); $(id).addEventListener('change', onInput); });
    const presetBtns = [...document.querySelectorAll('#atPresets [data-preset]')];
    const onPreset = e => {
      const p = AREA_PRESETS[e.target.dataset.preset];
      if (!p) return;
      $('atLabel').value = p.label; $('atMode').value = p.mode;
      if (p.thickness != null) $('atThick').value = p.thickness;
      if (p.density != null) $('atDensity').value = p.density;
      $('atRebar').value = p.rebar != null ? p.rebar : 'none';
      $('atForm').checked = p.form != null ? p.form : false;
      if (p.tack != null) $('atTack').value = p.tack;
      if (p.swell != null) $('atSwell').value = p.swell;
      if (p.respread != null) $('atRespread').value = p.respread;
      $('atColor').value = autoAreaColor(p.mode, p.label);
      onInput();
    };
    presetBtns.forEach(b => b.addEventListener('click', onPreset));
    const cleanup = () => {
      inputs.forEach(id => { $(id).removeEventListener('input', onInput); $(id).removeEventListener('change', onInput); });
      presetBtns.forEach(b => b.removeEventListener('click', onPreset));
      $('atOk').onclick = null; $('atCancel').onclick = null;
      $('areaTakeoff').classList.add('hidden');
    };
    $('atCancel').onclick = () => { cleanup(); resolve(null); };
    $('atOk').onclick = () => { const cfg = readAreaCfg(); cleanup(); resolve(cfg); };
  });
}

// live area/perimeter (feet) for a stored qarea markup, from its sheet's scale
const qareaSf = m => polygonAreaFt2(m.pts, state.scales[m.page] || 0);
const qareaPerimFt = m => areaPerimeterFt(m); // holes-aware: outer + hole rings, no bridge double-count

// Side-menu subtotals: roll up a takeoff group by material/type. Areas net out
// deducts within the same material+unit; lines sum length (+trench CY); counts
// sum items. Returns [{ label, text }] ready to render as subtotal rows.
function takeoffSubtotals(kind, items) {
  const map = new Map();
  if (kind === 'qarea') {
    for (const m of items) {
      const cfg = m.cfg || {};
      const r = computeAreaResult(qareaSf(m), cfg, qareaPerimFt(m));
      const unit = r.unit || 'SF';
      const label = cfg.label || 'Area';
      const key = `${label} ${unit}`;
      const g = map.get(key) || { label, unit, total: 0 };
      g.total += (cfg.deduct ? -1 : 1) * (r.quantity || 0);
      map.set(key, g);
    }
    return [...map.values()].map(g => ({ label: g.label, text: `${fmt(g.total, g.unit === 'SF' ? 0 : 1)} ${g.unit}` }));
  }
  if (kind === 'qline') {
    for (const m of items) {
      const cfg = m.cfg || {};
      const r = computeLineResult(qlineLenFt(m), cfg);
      const label = pipeScheduleLabel(cfg);
      const g = map.get(label) || { label, lengthFt: 0, trenchCY: 0 };
      g.lengthFt += r.lengthFt || 0; g.trenchCY += r.trenchCY || 0;
      map.set(label, g);
    }
    return [...map.values()].map(g => ({ label: g.label, text: `${fmt(g.lengthFt)} ft${g.trenchCY ? ` · ${fmt(g.trenchCY, 1)} CY` : ''}` }));
  }
  for (const m of items) { // qcount
    const cfg = m.cfg || {};
    const label = cfg.label || 'Item', unit = cfg.unit || 'EA';
    const key = `${label} ${unit}`;
    const g = map.get(key) || { label, unit, count: 0 };
    g.count += m.pts.length;
    map.set(key, g);
  }
  return [...map.values()].map(g => ({ label: g.label, text: `${g.count} ${g.unit}` }));
}

// rough $/unit starting points per material component (user edits in the bid)
const QA_COMP_LABEL = { concrete: 'concrete', forms: 'edge forms', rebar: 'rebar', mesh: 'wire mesh', asphalt: 'asphalt', tack: 'tack coat', base: 'agg. base', gravel: 'gravel / fill', strip: 'topsoil haul-off', area: 'area' };
const QA_COMP_PRICE = { concrete: 165, forms: 3.5, rebar: 0.9, mesh: 0.35, asphalt: 95, tack: 3, base: 28, gravel: 32, strip: 8, area: 0 };

// aggregate qarea markups into bid lines (deducts subtract from their label's
// components; quantities computed per-area so differing thicknesses are exact)
function areaBidLines() {
  const groups = new Map(); // label -> { comps: { comp: {unit, qty} } }
  for (const m of state.markups) {
    if (m.kind !== 'qarea') continue;
    const cfg = m.cfg || {};
    const sign = cfg.deduct ? -1 : 1;
    const r = computeAreaResult(qareaSf(m), cfg, qareaPerimFt(m));
    const g = groups.get(cfg.label) || { comps: {} };
    const add = (comp, unit, val) => { if (!val) return; (g.comps[comp] = g.comps[comp] || { unit, qty: 0 }).qty += sign * val; };
    if (cfg.mode === 'concrete') {
      add('concrete', 'CY', r.quantity);
      if (r.formworkLF) add('forms', 'LF', r.formworkLF);
      if (r.rebar) r.rebar.type === 'mesh' ? add('mesh', 'SF', r.rebar.meshSf) : add('rebar', 'lb', r.rebar.weightLb);
    } else if (cfg.mode === 'paving') {
      add('asphalt', 'tons', r.quantity);
      if (r.tackGal) add('tack', 'gal', r.tackGal);
    } else if (cfg.mode === 'tons') add('base', 'tons', r.quantity);
    else if (cfg.mode === 'cy') add('gravel', 'CY', r.quantity);
    else if (cfg.mode === 'strip') add('strip', 'CY', r.netExportLooseCY);
    else add('area', 'SF', r.areaSf);
    groups.set(cfg.label, g);
  }
  const lines = [];
  for (const [label, g] of groups) {
    const slug = String(label).replace(/[^a-z0-9]+/gi, '_'); // keep the price key attribute-safe
    for (const [comp, { unit, qty }] of Object.entries(g.comps)) {
      if (Math.abs(qty) < 0.01) continue;
      lines.push({ key: `qa_${slug}_${comp}`, label: `${label} — ${QA_COMP_LABEL[comp] || comp}`, qty, unit, q: 0, defPrice: QA_COMP_PRICE[comp] || 0 });
    }
  }
  return lines;
}

/* ---- Q2: Line / trench takeoff (copied from sitework — see PARITY.md) ---- */
// trench cross-section (trapezoid): bottom width w, depth d, side slope s (H:V)
function wallSectionAreaSf(bottomWidth, depth, slope) {
  if (!(depth > 0) || !(bottomWidth >= 0)) return 0;
  return bottomWidth * depth + slope * depth * depth;
}
const LINE_PRESETS = {
  curb:     { label: 'Curb & gutter', trench: false },
  pipe:     { label: 'Pipe / utility trench', trench: true, width: 3, depth: 5, slope: 0, bedding: 6 },
  pipe12:   { label: '12" pipe trench', trench: true, width: 3,   depth: 5, slope: 0, bedding: 6, dia: 12 },
  pipe18:   { label: '18" pipe trench', trench: true, width: 3.5, depth: 5, slope: 0, bedding: 6, dia: 18 },
  pipe24:   { label: '24" pipe trench', trench: true, width: 4,   depth: 6, slope: 0, bedding: 6, dia: 24 },
  pipe36:   { label: '36" pipe trench', trench: true, width: 5,   depth: 6, slope: 0, bedding: 6, dia: 36 },
  silt:     { label: 'Silt fence', trench: false },
  sawcut:   { label: 'Sawcut', trench: false },
  fence:    { label: 'Fence / guardrail', trench: false },
  lineonly: { label: 'Line', trench: false },
};
function autoLineColor(label) {
  const s = String(label || '').toLowerCase();
  if (s.includes('pipe')) return '#4da3ff';
  if (s.includes('curb')) return '#c9ced6';
  if (s.includes('silt')) return '#8bbf3f';
  if (s.includes('saw')) return '#e05555';
  if (s.includes('fence') || s.includes('guardrail')) return '#c07ef7';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AREA_PALETTE[h % AREA_PALETTE.length];
}
const lineColorHex = cfg => (cfg && cfg.color) || autoLineColor(cfg && cfg.label);
let lastLineColor = null;
let lastLineCfg = null;
function defaultNewLineColor() {
  const sel = selMarkup();
  if (sel && sel.kind === 'qline') return lineColorHex(sel.cfg);
  return lastLineColor;
}
// Pipe schedule grouping: sized pipe runs roll up by diameter × material
// (e.g. '24" RCP'); everything else keeps its freetext label. Storm/utility pack.
function pipeScheduleLabel(cfg) {
  const dia = parseFloat(cfg && cfg.dia) || 0;
  if (STORM_ON && dia > 0) return `${dia}" ${(cfg.mat || 'pipe')}`;
  return (cfg && cfg.label) || 'Line';
}
function computeLineResult(lengthFt, cfg) {
  const r = { lengthFt, label: cfg.label, trench: !!cfg.trench, trenchCY: 0, beddingCY: 0, dia: parseFloat(cfg.dia) || 0, mat: cfg.mat || '', d1: 0, d2: 0, avgDepth: 0, pipeCY: 0, backfillCY: 0, exportCY: 0, importBackfillCY: 0 };
  if (cfg.trench) {
    const w = parseFloat(cfg.width) || 0, s = parseFloat(cfg.slope) || 0;
    // invert-driven: depth can vary end-to-end; use the average end area for volume
    const d1 = parseFloat(cfg.depth) || 0, d2 = STORM_ON ? (parseFloat(cfg.depth2) || 0) : 0;
    const d = d2 > 0 ? (d1 + d2) / 2 : d1;
    r.d1 = d1; r.d2 = d2; r.avgDepth = d;
    r.trenchCY = wallSectionAreaSf(w, d, s) * lengthFt / 27;
    const bedIn = parseFloat(cfg.bedding) || 0;
    r.beddingCY = bedIn > 0 ? (w * (bedIn / 12) * lengthFt) / 27 : 0;
    // spoil / backfill netting: pipe displaces backfill; native reuse hauls only
    // the displaced volume (pipe + bedding), import hauls all spoil off
    r.pipeCY = r.dia > 0 ? (Math.PI / 4) * Math.pow(r.dia / 12, 2) * lengthFt / 27 : 0;
    r.backfillCY = Math.max(0, r.trenchCY - r.beddingCY - r.pipeCY);
    const importBf = cfg.backfill === 'import';
    r.exportCY = importBf ? r.trenchCY : (r.beddingCY + r.pipeCY);
    r.importBackfillCY = importBf ? r.backfillCY : 0;
  }
  return r;
}
function lineResultRows(lengthFt, cfg) {
  const r = computeLineResult(lengthFt, cfg);
  const rows = [['Length', `${fmt(lengthFt)} ft`, r.trench ? '' : 'total']];
  if (r.trench) {
    if (r.d2 > 0) rows.push(['Avg depth', `${fmt(r.avgDepth, 1)} ft (${fmt(r.d1, 1)}→${fmt(r.d2, 1)})`]);
    rows.push(['Trench excavation', `${fmt(r.trenchCY, 1)} CY`, 'total']);
    if (r.beddingCY > 0) rows.push(['Bedding (import)', `${fmt(r.beddingCY, 1)} CY`]);
    if (STORM_ON) {
      if (r.pipeCY > 0) rows.push(['Pipe volume', `${fmt(r.pipeCY, 1)} CY`]);
      if (r.importBackfillCY > 0) rows.push(['Import backfill', `${fmt(r.importBackfillCY, 1)} CY`]);
      if (r.exportCY > 0.05) rows.push(['Net export (bank)', `${fmt(r.exportCY, 1)} CY`]);
    }
  }
  return rows.map(([k, v, cls]) => `<div class="res-row ${cls === 'total' ? 'total' : ''}"><span>${k}</span><b>${v}</b></div>`).join('');
}
function readLineCfg() {
  return {
    label: $('ltLabel').value.trim() || 'Line', trench: $('ltTrench').checked,
    width: $('ltWidth').value, depth: $('ltDepth').value, depth2: $('ltDepth2').value, slope: $('ltSlope').value,
    bedding: $('ltBedding').value, backfill: $('ltBackfill').value, color: $('ltColor').value,
    dia: parseFloat($('ltDia').value) || 0, mat: $('ltMat').value,
  };
}
function syncLineTrench() { $('ltTrenchFields').style.display = $('ltTrench').checked ? '' : 'none'; }
function askLineConfig(lengthFt, prefill) {
  return new Promise(resolve => {
    const preview = () => { $('ltResult').innerHTML = lineResultRows(lengthFt, readLineCfg()); };
    $('ltLen').textContent = `${fmt(lengthFt)} ft`;
    if (prefill) {
      $('ltLabel').value = prefill.label != null ? prefill.label : '';
      $('ltTrench').checked = !!prefill.trench;
      if (prefill.width != null) $('ltWidth').value = prefill.width;
      if (prefill.depth != null) $('ltDepth').value = prefill.depth;
      if (prefill.depth2 != null) $('ltDepth2').value = prefill.depth2;
      if (prefill.slope != null) $('ltSlope').value = prefill.slope;
      if (prefill.bedding != null) $('ltBedding').value = prefill.bedding;
      if (prefill.backfill != null) $('ltBackfill').value = prefill.backfill;
      if (prefill.dia != null) $('ltDia').value = prefill.dia;
      if (prefill.mat != null) $('ltMat').value = prefill.mat;
    }
    $('ltColor').value = (prefill && prefill.color) || defaultNewLineColor() || autoLineColor($('ltLabel').value);
    syncLineTrench();
    preview();
    $('lineTakeoff').classList.remove('hidden');
    const onInput = () => { syncLineTrench(); preview(); };
    const inputs = ['ltLabel', 'ltTrench', 'ltWidth', 'ltDepth', 'ltDepth2', 'ltSlope', 'ltBedding', 'ltBackfill', 'ltMat'];
    inputs.forEach(id => { $(id).addEventListener('input', onInput); $(id).addEventListener('change', onInput); });
    // typing a diameter suggests a trench bottom width (pipe Ø + ~2 ft working
    // room, to the nearest half-foot); still editable afterward
    const onDia = () => { const dia = parseFloat($('ltDia').value) || 0; if (dia > 0) $('ltWidth').value = Math.round((dia / 12 + 2) * 2) / 2; onInput(); };
    $('ltDia').addEventListener('input', onDia); $('ltDia').addEventListener('change', onDia);
    const presetBtns = [...document.querySelectorAll('#ltPresets [data-preset]')];
    const onPreset = e => {
      const p = LINE_PRESETS[e.target.dataset.preset];
      if (!p) return;
      $('ltLabel').value = p.label; $('ltTrench').checked = !!p.trench;
      if (p.width != null) $('ltWidth').value = p.width;
      if (p.depth != null) $('ltDepth').value = p.depth;
      $('ltDepth2').value = p.depth2 != null ? p.depth2 : 0; // presets are constant-depth
      if (p.slope != null) $('ltSlope').value = p.slope;
      if (p.bedding != null) $('ltBedding').value = p.bedding;
      $('ltDia').value = p.dia != null ? p.dia : 0; // non-pipe presets clear the diameter
      $('ltColor').value = autoLineColor(p.label);
      onInput();
    };
    presetBtns.forEach(b => b.addEventListener('click', onPreset));
    const cleanup = () => {
      inputs.forEach(id => { $(id).removeEventListener('input', onInput); $(id).removeEventListener('change', onInput); });
      $('ltDia').removeEventListener('input', onDia); $('ltDia').removeEventListener('change', onDia);
      presetBtns.forEach(b => b.removeEventListener('click', onPreset));
      $('ltOk').onclick = null; $('ltCancel').onclick = null;
      $('lineTakeoff').classList.add('hidden');
    };
    $('ltCancel').onclick = () => { cleanup(); resolve(null); };
    $('ltOk').onclick = () => { const cfg = readLineCfg(); lastLineColor = cfg.color; cleanup(); resolve(cfg); };
  });
}
const qlineLenFt = m => polyLengthFt(m.pts, state.scales[m.page] || 0);
const QL_DEFAULT_PRICE = { lf: 0, trench: 6, bedding: 32, export: 8, backfill_import: 18 };
function lineBidLines() {
  const groups = new Map();
  for (const m of state.markups) {
    if (m.kind !== 'qline') continue;
    const cfg = m.cfg || {};
    const r = computeLineResult(qlineLenFt(m), cfg);
    // sized pipe runs roll up by Ø × material (the pipe schedule); other runs by label
    const groupLabel = pipeScheduleLabel(cfg);
    const g = groups.get(groupLabel) || { comps: {} };
    const add = (comp, unit, val) => { if (!val) return; (g.comps[comp] = g.comps[comp] || { unit, qty: 0 }).qty += val; };
    add('lf', 'LF', r.lengthFt);
    add('trench', 'CY', r.trenchCY);
    add('bedding', 'CY', r.beddingCY);
    if (STORM_ON) { add('backfill_import', 'CY', r.importBackfillCY); add('export', 'CY', r.exportCY); }
    groups.set(groupLabel, g);
  }
  const COMP = { lf: '', trench: 'trench excavation', bedding: 'bedding', backfill_import: 'import backfill', export: 'export / haul-off' };
  const lines = [];
  for (const [label, g] of groups) {
    const slug = String(label).replace(/[^a-z0-9]+/gi, '_');
    for (const [comp, { unit, qty }] of Object.entries(g.comps)) {
      if (Math.abs(qty) < 0.01) continue;
      lines.push({ key: `ql_${slug}_${comp}`, label: comp === 'lf' ? label : `${label} — ${COMP[comp]}`, qty, unit, q: 0, defPrice: QL_DEFAULT_PRICE[comp] || 0 });
    }
  }
  return lines;
}

/* ---- Q3: Count takeoff (copied from sitework — see PARITY.md) ---- */
const COUNT_PRESETS = {
  catchbasin: { label: 'Catch basin', unit: 'EA' }, manhole: { label: 'Manhole', unit: 'EA' },
  inlet: { label: 'Inlet', unit: 'EA' }, jbox: { label: 'Junction box', unit: 'EA' },
  cleanout: { label: 'Cleanout', unit: 'EA' }, fes: { label: 'Flared end section', unit: 'EA' },
  areadrain: { label: 'Area drain', unit: 'EA' }, tree: { label: 'Tree', unit: 'EA' },
  sign: { label: 'Sign', unit: 'EA' }, light: { label: 'Light pole', unit: 'EA' },
  bollard: { label: 'Bollard', unit: 'EA' }, itemonly: { label: 'Item', unit: 'EA' },
};
const readCountCfg = () => ({ label: $('ctLabel').value.trim() || 'Item', unit: $('ctUnit').value.trim() || 'EA', depth: parseFloat($('ctDepth').value) || 0 });
const countResultRows = (n, cfg) => {
  const d = STORM_ON ? (parseFloat(cfg.depth) || 0) : 0;
  let html = `<div class="res-row total"><span>${esc(cfg.label)}${d > 0 ? ` @ ${fmt(d, 1)} ft` : ''}</span><b>${n} ${esc(cfg.unit)}</b></div>`;
  if (d > 0) html += `<div class="res-row"><span>Vertical feet</span><b>${fmt(n * d, 1)} VF</b></div>`;
  return html;
};
function askCountConfig(n, prefill) {
  return new Promise(resolve => {
    const preview = () => { $('ctResult').innerHTML = countResultRows(n, readCountCfg()); };
    $('ctN').textContent = `${n} point${n === 1 ? '' : 's'}`;
    if (prefill) { $('ctLabel').value = prefill.label != null ? prefill.label : 'Item'; $('ctUnit').value = prefill.unit || 'EA'; $('ctDepth').value = prefill.depth != null ? prefill.depth : 0; }
    preview();
    $('countTakeoff').classList.remove('hidden');
    const onInput = () => preview();
    const inputs = ['ctLabel', 'ctUnit', 'ctDepth'];
    inputs.forEach(id => $(id).addEventListener('input', onInput));
    const presetBtns = [...document.querySelectorAll('#ctPresets [data-preset]')];
    const onPreset = e => {
      const p = COUNT_PRESETS[e.target.dataset.preset];
      if (!p) return;
      $('ctLabel').value = p.label; $('ctUnit').value = p.unit; onInput();
    };
    presetBtns.forEach(b => b.addEventListener('click', onPreset));
    const cleanup = () => {
      inputs.forEach(id => $(id).removeEventListener('input', onInput));
      presetBtns.forEach(b => b.removeEventListener('click', onPreset));
      $('ctOk').onclick = null; $('ctCancel').onclick = null;
      $('countTakeoff').classList.add('hidden');
    };
    $('ctCancel').onclick = () => { cleanup(); resolve(null); };
    $('ctOk').onclick = () => { const cfg = readCountCfg(); cleanup(); resolve(cfg); };
  });
}
function countBidLines() {
  const groups = new Map(); // "label|depth" -> { label, unit, depth, qty } — structure schedule by type × depth
  for (const m of state.markups) {
    if (m.kind !== 'qcount') continue;
    const cfg = m.cfg || {};
    const depth = STORM_ON ? (parseFloat(cfg.depth) || 0) : 0;
    const key = `${cfg.label}|${depth}`;
    const g = groups.get(key) || { label: cfg.label, unit: cfg.unit || 'EA', depth, qty: 0 };
    g.qty += m.pts.length;
    groups.set(key, g);
  }
  const lines = [];
  for (const g of groups.values()) {
    if (!g.qty) continue;
    const slug = String(g.label).replace(/[^a-z0-9]+/gi, '_');
    const tag = g.depth > 0 ? `_${g.depth}ft` : '';
    const dispLabel = g.depth > 0 ? `${g.label} @ ${fmt(g.depth, 1)} ft` : g.label;
    lines.push({ key: `qc_${slug}${tag}`, label: dispLabel, qty: g.qty, unit: g.unit, q: 0, defPrice: 0 });
    // depth → price the risers by vertical foot too (structures get deeper = costlier)
    if (g.depth > 0) lines.push({ key: `qc_${slug}${tag}_vf`, label: `${g.label} — vertical feet`, qty: g.qty * g.depth, unit: 'VF', q: 0, defPrice: 0 });
  }
  return lines;
}
let lastCountCfg = null;

/* ===================== W1: Auto-trace vector wand =====================
 * Reads the page's vector line work (pdf.js operator list) and, on click,
 * snaps to the nearest stroked path — stitching adjacent segments into one
 * run — to lay down a contour in a single click, prefilling its elevation
 * from the nearest printed number. Copied from sitework (see PARITY.md).
 */
const pathCache = {}; // `${docKey}:${page}` -> { polys, labels } in base px
function clearPathCache() { for (const k of Object.keys(pathCache)) delete pathCache[k]; }
function matMul(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}
const matApply = (M, x, y) => ({ x: M[0] * x + M[2] * y + M[4], y: M[1] * x + M[3] * y + M[5] });
function flattenCubic(p0, c1, c2, p3, out) {
  for (let i = 1; i <= 8; i++) {
    const t = i / 8, u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
    });
  }
}
async function buildPathIndex(pageNum) {
  const key = `${state.docKey}:${pageNum}`;
  if (pathCache[key]) return pathCache[key];
  const page = await state.doc.raw.getPage(pageNum);
  const pvp = page.getViewport({ scale: 1 }); // base px = markup coordinate space
  const opList = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;
  const F = opList.fnArray, A = opList.argsArray;
  const STROKES = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const polys = [];
  let M = pvp.transform.slice();
  const stack = [];
  const finishPoly = pts => {
    if (pts.length < 2) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
    polys.push({ pts, x0, y0, x1, y1 });
  };
  for (let i = 0; i < F.length; i++) {
    const fn = F[i];
    if (fn === OPS.save) stack.push(M.slice());
    else if (fn === OPS.restore) { if (stack.length) M = stack.pop(); }
    else if (fn === OPS.transform) M = matMul(M, A[i]);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(M.slice()); if (A[i] && A[i][0]) M = matMul(M, A[i][0]); }
    else if (fn === OPS.paintFormXObjectEnd) { if (stack.length) M = stack.pop(); }
    else if (fn === OPS.constructPath) {
      if (!STROKES.has(F[i + 1])) continue; // fills (hatches, blobs) aren't contours
      const [subOps, co] = A[i];
      let k = 0, cur = [], start = null;
      const raw = (x, y) => matApply(M, x, y);
      for (const op of subOps) {
        if (op === OPS.moveTo) { finishPoly(cur); start = raw(co[k], co[k + 1]); k += 2; cur = [start]; }
        else if (op === OPS.lineTo) { cur.push(raw(co[k], co[k + 1])); k += 2; }
        else if (op === OPS.curveTo) { const c1 = raw(co[k], co[k + 1]), c2 = raw(co[k + 2], co[k + 3]), p3 = raw(co[k + 4], co[k + 5]); k += 6; if (cur.length) flattenCubic(cur[cur.length - 1], c1, c2, p3, cur); }
        else if (op === OPS.curveTo2) { const c2 = raw(co[k], co[k + 1]), p3 = raw(co[k + 2], co[k + 3]); k += 4; if (cur.length) flattenCubic(cur[cur.length - 1], cur[cur.length - 1], c2, p3, cur); }
        else if (op === OPS.curveTo3) { const c1 = raw(co[k], co[k + 1]), p3 = raw(co[k + 2], co[k + 3]); k += 4; if (cur.length) flattenCubic(cur[cur.length - 1], c1, p3, p3, cur); }
        else if (op === OPS.closePath) { if (start && cur.length) cur.push({ x: start.x, y: start.y }); }
        else if (op === OPS.rectangle) { finishPoly(cur); cur = []; const x = co[k], y = co[k + 1], w2 = co[k + 2], h2 = co[k + 3]; k += 4; finishPoly([raw(x, y), raw(x + w2, y), raw(x + w2, y + h2), raw(x, y + h2), raw(x, y)]); }
      }
      finishPoly(cur);
    }
  }
  const labels = []; // numeric text (for elevation prefill)
  try {
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      const s = it.str.trim();
      if (/^\d{2,4}(?:\.\d{1,2})?$/.test(s)) { const T = matMul(pvp.transform, it.transform); labels.push({ x: T[4], y: T[5], val: parseFloat(s) }); }
    }
  } catch (_) { /* no text layer */ }
  const res = { polys, labels };
  pathCache[key] = res;
  return res;
}
// join contiguous stroked segments end-to-end (bridging small gaps, angle-gated)
function stitchChain(seed, polys) {
  const TOUCH = 3, BRIDGE = 18, ANG = Math.cos(35 * Math.PI / 180);
  const unit = (x, y) => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; };
  const dot = (u, v) => u.x * v.x + u.y * v.y;
  const used = new Set([seed]);
  let chain = seed.pts.slice();
  const grow = atEnd => {
    for (;;) {
      if (chain.length > 20000) break;
      const tip = atEnd ? chain[chain.length - 1] : chain[0];
      const nb = atEnd ? chain[chain.length - 2] : chain[1];
      let pick = null, pickRev = false, pickD = BRIDGE;
      for (const poly of polys) {
        if (used.has(poly)) continue;
        if (tip.x < poly.x0 - BRIDGE || tip.x > poly.x1 + BRIDGE || tip.y < poly.y0 - BRIDGE || tip.y > poly.y1 + BRIDGE) continue;
        const a = poly.pts[0], b = poly.pts[poly.pts.length - 1];
        const da = dist(tip.x, tip.y, a.x, a.y), db = dist(tip.x, tip.y, b.x, b.y);
        const rev = db < da, d = rev ? db : da;
        if (d >= pickD) continue;
        if (d > TOUCH) {
          const first = rev ? b : a;
          const second = (rev ? poly.pts[poly.pts.length - 2] : poly.pts[1]) || first;
          const dirTip = unit(tip.x - nb.x, tip.y - nb.y);
          const dirGap = unit(first.x - tip.x, first.y - tip.y);
          const dirNew = unit(second.x - first.x, second.y - first.y);
          if (dot(dirTip, dirGap) < ANG || dot(dirGap, dirNew) < ANG) continue;
        }
        pick = poly; pickRev = rev; pickD = d;
      }
      if (!pick) break;
      used.add(pick);
      const pts = pickRev ? pick.pts.slice().reverse() : pick.pts.slice();
      if (atEnd) chain = chain.concat(pts);
      else chain = pts.reverse().concat(chain);
    }
  };
  grow(true);
  grow(false);
  return chain;
}
// shared: read the page vectors and pick the stitched run nearest the click
async function wandPickPath(w) {
  if (!state.doc || state.doc.kind !== 'pdf') { setMsg('Auto-trace needs a vector PDF — trace by hand instead.'); return null; }
  setMsg('Reading the page’s vector line work…');
  let idx;
  try { idx = await buildPathIndex(state.page); }
  catch (_) { setMsg('Could not read vector paths from this page (scanned PDF?).'); return null; }
  if (!idx.polys.length) { setMsg('No vector line work on this page (scanned PDF?).'); return null; }
  const thresh = Math.max(3, 8 / vp.view.zoom);
  let best = null, bestD = thresh;
  for (const poly of idx.polys) {
    if (w.x < poly.x0 - thresh || w.x > poly.x1 + thresh || w.y < poly.y0 - thresh || w.y > poly.y1 + thresh) continue;
    const d = distToPolyline(w.x, w.y, poly.pts);
    if (d < bestD) { bestD = d; best = poly; }
  }
  if (!best) { setMsg('No line under the click — zoom in and click right on the line.'); return null; }
  return { pts: simplifyPts(stitchChain(best, idx.polys), 2.5), idx };
}

async function wandTrace(w) {
  const r = await wandPickPath(w);
  if (!r) return;
  const { pts, idx } = r;
  if (pts.length < 2) { setMsg('That line is a single point — use ◎ Spot for spot grades.'); return; }
  let labelVal = null, labelD = 90;
  for (const L of idx.labels) { const d = dist(w.x, w.y, L.x, L.y); if (d < labelD) { labelD = d; labelVal = L.val; } }
  const surf = curSurface;
  const prev = snapshot();
  const m = { id: randId(), page: state.page, kind: 'contour', surface: surf, color: curColor(), width: curWidth(), pts, elev: null, created: Date.now() };
  state.markups.push(m);
  pushUndo(prev);
  markupsChanged();
  modals.askNumber(`Contour elevation (ft) — ${surf}`, 'prefilled from the nearest printed number if one was found', labelVal != null ? labelVal : nextElevDefault(surf), 1)
    .then(v => { if (v != null) { m.elev = v; lastElev[surf] = v; markupsChanged(); } });
}

// auto-area: click a CLOSED vector boundary → area takeoff (NEW — sitework's
// autoAreaClick was only a hatch-detect stub, so this has no counterpart there)
async function wandArea(w) {
  if (!pageFtPerPx()) { setMsg('Calibrate this sheet (📏) first — area needs a scale.'); return; }
  const r = await wandPickPath(w);
  if (!r) return;
  const pts = r.pts;
  const closed = pts.length >= 4 && dist(pts[0].x, pts[0].y, pts[pts.length - 1].x, pts[pts.length - 1].y) < 12;
  if (!closed) { setMsg('That isn’t a closed shape — click the outline of a closed area (a building / paving edge), or use ▨ Area to trace it.'); return; }
  const s = pageFtPerPx();
  askAreaConfig(polygonAreaFt2(pts, s), polygonPerimeterFt(pts, s), lastAreaCfg).then(cfg => {
    if (!cfg) { vp.requestDraw(); return; }
    const prev = snapshot();
    rememberAreaCfg(cfg);
    state.markups.push({ id: randId(), page: state.page, kind: 'qarea', pts, cfg, created: Date.now() });
    pushUndo(prev);
    markupsChanged();
  });
}

/* ===================== Drywall & Paint pack (D1) =====================
 * Height turns plan-view line work into vertical SF: a wall run is a polyline
 * whose SF = LF × height × sides; a ceiling is a polygon (area SF). Materials
 * (board / mud / tape / paint) flow into the shared bid. New trade, not a port.
 */
const dwallLenFt = m => polyLengthFt(m.pts, state.scales[m.page] || 0);
const dwallHeight = m => (m.height != null ? m.height : state.drywall.wallHeight);
const dwallSf = m => dwallLenFt(m) * dwallHeight(m) * (m.sides || 2);
const dceilingSf = m => polygonAreaFt2(m.pts, state.scales[m.page] || 0);
const dheightFt = m => polyLengthFt(m.pts, state.scales[m.page] || 0); // measured wall height off an elevation sheet
const froomSf = m => polygonAreaFt2(m.pts, state.scales[m.page] || 0); // flooring room area
const ftransLenFt = m => polyLengthFt(m.pts, state.scales[m.page] || 0); // flooring transition run
const fwallLenFt = m => polyLengthFt(m.pts, state.scales[m.page] || 0); // framed wall run
const fsheathSf = m => polygonAreaFt2(m.pts, state.scales[m.page] || 0); // sheathing area
const esclineLenFt = m => polyLengthFt(m.pts, state.scales[m.page] || 0); // ESC linear control run
const escareaSf = m => polygonAreaFt2(m.pts, state.scales[m.page] || 0); // ESC stabilized area
const sstripeLenFt = m => polyLengthFt(m.pts, state.scales[m.page] || 0); // painted stripe run
const swallSf = m => polygonAreaFt2(m.pts, state.scales[m.page] || 0); // siding elevation (gross)
const sgutterLenFt = m => polyLengthFt(m.pts, state.scales[m.page] || 0); // gutter / downspout run
const sinsulSf = m => polygonAreaFt2(m.pts, state.scales[m.page] || 0); // insulated area
const dmareaSf = m => polygonAreaFt2(m.pts, state.scales[m.page] || 0); // demolition area
const dmlineLenFt = m => polyLengthFt(m.pts, state.scales[m.page] || 0); // linear removal run
const fnlineLenFt = m => polyLengthFt(m.pts, state.scales[m.page] || 0); // fence run
const lsareaSf = m => polygonAreaFt2(m.pts, state.scales[m.page] || 0); // landscape area
const lslineLenFt = m => polyLengthFt(m.pts, state.scales[m.page] || 0); // irrigation run
// Posts for ONE run: a run needs a post at both ends, so this is +1 and MUST be
// evaluated per run — summing LF first and computing once loses a post per run
// (two 50ft runs @10ft = 6+6 = 12 posts, not ceil(100/10)+1 = 11).
function fencePostsFor(lf, ftype) {
  if (!(lf > 0)) return 0;
  const sp = FN_LINE_SPACING[ftype] || 8;
  return Math.ceil(lf / sp) + 1;
}
const FINISH_MUD = { L3: 0.020, L4: 0.027, L5: 0.036 }; // gal ready-mix / SF by finish level
// Suspended (ACT) drop-ceiling grid takeoff from area + wall perimeter. Rule-of-thumb
// counts: mains 4' OC, 4' cross tees 2' OC (both layouts), 2' cross tees only on 2×2;
// wall angle around the room perimeter; hanger wire ~1 per 16 SF.
function actGrid(sf, perimFt, ctype) {
  const A = Math.max(0, sf), P = Math.max(0, perimFt);
  const waste = 1 + (Number(state.drywall.waste) || 0) / 100;
  const tiles = Math.ceil(A / (ctype === 'act22' ? 4 : 8) * waste);
  return {
    sf: A,
    tiles,
    mainPc: Math.ceil(A / 4 / 12),               // 12' main tees
    cross4: Math.ceil(A / 8),                     // 4' cross tees
    cross2: ctype === 'act22' ? Math.ceil(A / 4) : 0, // 2' cross tees (2×2 only)
    angleLF: P,
    anglePc: Math.ceil(P / 10),                   // 10' wall-angle sticks
    hangers: Math.ceil(A / 16),                   // hanger wires
  };
}
function drywallTotals() {
  const D = state.drywall;
  let wallSF = 0, ceilSF = 0, wallLF = 0, wallFaceSF = 0, openDeductSF = 0;
  const act = { act24: { sf: 0, perim: 0 }, act22: { sf: 0, perim: 0 } };
  const openCounts = { door: 0, window: 0, opening: 0 };
  const trimLF = { base: 0, crown: 0, chair: 0 };
  for (const m of state.markups) {
    if (m.kind === 'dwall') { wallSF += dwallSf(m); wallLF += dwallLenFt(m); wallFaceSF += dwallLenFt(m) * dwallHeight(m); }
    else if (m.kind === 'dceiling') {
      const ct = (m.cfg && m.cfg.ctype) || 'drywall';
      const sf = dceilingSf(m);
      if (act[ct]) { act[ct].sf += sf; act[ct].perim += areaPerimeterFt(m); }
      else ceilSF += sf; // drywall ceiling
    }
    else if (m.kind === 'dopening') { const c = m.cfg || {}; const n = m.pts.length; openDeductSF += n * (Number(c.deductSF) || 0); if (openCounts[c.otype] != null) openCounts[c.otype] += n; }
    else if (m.kind === 'dtrim') { const c = m.cfg || {}; if (trimLF[c.ttype] != null) trimLF[c.ttype] += polyLengthFt(m.pts, state.scales[m.page] || 0); }
  }
  const netWallSF = Math.max(0, wallSF - openDeductSF);
  const boardSF = Math.max(0, netWallSF + ceilSF); // drywall board = walls + drywall ceilings (ACT excluded)
  const boards = Math.ceil(boardSF * (1 + (Number(D.waste) || 0) / 100) / (Number(D.sheetSF) || 32));
  const mudGal = boardSF * (FINISH_MUD[D.finish] || 0.027);
  const tapeLF = boardSF * 0.37;
  const paintGal = Number(D.coverage) > 0 ? (boardSF / Number(D.coverage)) * (Number(D.coats) || 1) : 0;
  const texture = D.texture || 'none';
  const textureSF = texture !== 'none' ? boardSF : 0;       // finished drywall surface gets texture
  const insul = D.insul || 'none';
  const insulSF = insul !== 'none' ? wallFaceSF : 0;         // one batt layer per wall cavity (single face, not ×sides)
  const actQ = {};
  for (const k of ['act24', 'act22']) if (act[k].sf > 0.5) actQ[k] = actGrid(act[k].sf, act[k].perim, k);
  return { wallSF, netWallSF, ceilSF, boardSF, wallLF, wallFaceSF, openDeductSF, openCounts, trimLF, boards, mudGal, tapeLF, paintGal, texture, textureSF, insul, insulSF, actQ };
}
const DW_DEFAULT_PRICE = { hang: 0.55, finish: 0.65, board: 12, mud: 16, tape: 5, paint: 45, door: 65, window: 45, opening: 30, trim_base: 2.5, trim_crown: 4.5, trim_chair: 3.5, act24: 4.75, act22: 5.75 };
function drywallBidLines() {
  const T = drywallTotals();
  const D = state.drywall;
  const lines = [];
  if (T.boardSF >= 0.5) lines.push(
    { key: 'dw_hang', label: 'Drywall hang (labor)', qty: T.boardSF, unit: 'SF', q: 0, defPrice: DW_DEFAULT_PRICE.hang },
    { key: 'dw_finish', label: `Drywall finish ${D.finish} (labor)`, qty: T.boardSF, unit: 'SF', q: 0, defPrice: DW_DEFAULT_PRICE.finish },
    { key: 'dw_board', label: `Drywall board (${D.sheetSF} SF sheets · ${D.waste}% waste)`, qty: T.boards, unit: 'sheet', q: 0, defPrice: DW_DEFAULT_PRICE.board },
    { key: 'dw_mud', label: 'Joint compound', qty: T.mudGal, unit: 'gal', q: 0, defPrice: DW_DEFAULT_PRICE.mud },
    { key: 'dw_tape', label: 'Joint tape', qty: T.tapeLF, unit: 'LF', q: 0, defPrice: DW_DEFAULT_PRICE.tape },
  );
  if (T.textureSF >= 0.5) lines.push({ key: 'dw_texture', label: `Texture — ${TEXTURE_LABEL[T.texture]}`, qty: T.textureSF, unit: 'SF', q: 0, defPrice: TEXTURE_PRICE[T.texture] || 0.4 });
  if (T.boardSF >= 0.5) lines.push({ key: 'dw_paint', label: `Paint (${D.coats} coats)`, qty: T.paintGal, unit: 'gal', q: 0, defPrice: DW_DEFAULT_PRICE.paint });
  if (T.insulSF >= 0.5) lines.push({ key: 'dw_insul', label: `Insulation — ${INSUL_LABEL[T.insul]}`, qty: T.insulSF, unit: 'SF', q: 0, defPrice: INSUL_PRICE[T.insul] || 0.6 });
  for (const k of ['act24', 'act22']) if (T.actQ[k]) lines.push({ key: 'dw_' + k, label: `Suspended ceiling — ${CEIL_LABEL[k]} (installed)`, qty: T.actQ[k].sf, unit: 'SF', q: 0, defPrice: DW_DEFAULT_PRICE[k] });
  for (const k of ['door', 'window', 'opening']) if (T.openCounts[k]) lines.push({ key: 'dw_' + k, label: `${OPENING_LABEL[k]} (paint / case)`, qty: T.openCounts[k], unit: 'EA', q: 0, defPrice: DW_DEFAULT_PRICE[k] });
  for (const k of ['base', 'crown', 'chair']) if (T.trimLF[k] > 0.5) lines.push({ key: 'dw_trim_' + k, label: `${TRIM_LABEL[k]} trim`, qty: T.trimLF[k], unit: 'LF', q: 0, defPrice: DW_DEFAULT_PRICE['trim_' + k] });
  return lines;
}
function renderDrywallPanel() {
  const panel = $('dwPanel');
  if (!panel || panel.classList.contains('hidden')) return;
  const D = state.drywall;
  const T = drywallTotals();
  const rows = [];
  const R = (a, b) => rows.push(`<div class="dirt-row"><span>${a}</span><span class="v">${b}</span></div>`);
  const texOpts = ['none', 'smooth', 'orange', 'knockdown', 'popcorn'].map(k => `<option value="${k}">${TEXTURE_LABEL[k]}</option>`).join('');
  const insOpts = ['none', 'r11', 'r13', 'r15', 'r19', 'r21', 'sound'].map(k => `<option value="${k}">${INSUL_LABEL[k]}</option>`).join('');
  rows.push('<div class="roof-sub">Settings</div>');
  rows.push(`<div class="dirt-set">Wall height <input type="number" id="dwHeight" min="1" step="0.5"> ft · new runs <b>${curDwSides}-side</b></div>`);
  rows.push('<div class="dirt-set">Sheet <select id="dwSheet"><option value="32">4×8 (32)</option><option value="40">4×10 (40)</option><option value="48">4×12 (48)</option></select> SF · Waste <input type="number" id="dwWaste" min="0"> %</div>');
  rows.push('<div class="dirt-set">Paint <input type="number" id="dwCov" min="1"> SF/gal · Coats <input type="number" id="dwCoats" min="1"> · Finish <select id="dwFinish"><option>L3</option><option>L4</option><option>L5</option></select></div>');
  rows.push(`<div class="dirt-set">Texture <select id="dwTexture">${texOpts}</select> · Insulation <select id="dwInsul">${insOpts}</select></div>`);
  // heights measured off elevation sheets — apply as the new-run default or per-run (double-click a wall)
  rows.push('<div class="roof-sub">Heights (from elevations)</div>');
  const heights = state.markups.filter(m => m.kind === 'dheight');
  for (const h of heights) {
    const ft = dheightFt(h);
    const isDef = Math.abs((Number(D.wallHeight) || 0) - ft) < 0.05;
    rows.push(`<div class="dirt-row"><span>${esc(h.text || 'Height')}</span><span class="v">${fmt(ft, 1)} ft ${isDef ? '<b>· default</b>' : `<a class="dirt-link" data-huse="${ft}">use</a>`} <a class="dirt-link" data-hdel="${h.id}">✕</a></span></div>`);
  }
  rows.push(`<div class="dirt-set"><button class="btn" id="dwMeasureH">↕ Measure a height</button> <span class="hint">click floor→ceiling on an elevation sheet</span></div>`);
  rows.push('<div class="roof-sub">Quantities</div>');
  R('Wall SF (gross)', fmt(T.wallSF));
  if (T.openDeductSF > 0) R('− openings', `−${fmt(T.openDeductSF)}`);
  R('Drywall ceiling SF', fmt(T.ceilSF));
  rows.push(`<div class="dirt-row"><b>Board &amp; finish SF</b><span class="v"><b>${fmt(T.boardSF)}</b></span></div>`);
  R(`Boards (${D.sheetSF} SF)`, fmt(T.boards, 0));
  R('Joint compound', `${fmt(T.mudGal, 1)} gal`);
  R('Tape', `${fmt(T.tapeLF, 0)} LF`);
  if (T.textureSF > 0.5) R(`Texture (${TEXTURE_LABEL[T.texture]})`, `${fmt(T.textureSF, 0)} SF`);
  R(`Paint (${D.coats} coats)`, `${fmt(T.paintGal, 1)} gal`);
  if (T.insulSF > 0.5) R(`Insulation (${INSUL_LABEL[T.insul]})`, `${fmt(T.insulSF, 0)} SF`);
  const oc = T.openCounts, tl = T.trimLF;
  if (oc.door || oc.window || oc.opening) R('Openings', [oc.door && oc.door + ' dr', oc.window && oc.window + ' win', oc.opening && oc.opening + ' op'].filter(Boolean).join(' · '));
  const trimBits = ['base', 'crown', 'chair'].filter(k => tl[k] > 0.5).map(k => `${TRIM_LABEL[k]} ${fmt(tl[k], 0)}`);
  if (trimBits.length) R('Trim LF', trimBits.join(' · '));
  for (const k of ['act24', 'act22']) {
    const a = T.actQ[k]; if (!a) continue;
    rows.push(`<div class="roof-sub">${CEIL_LABEL[k]} drop-ceiling</div>`);
    R('Area', `${fmt(a.sf, 0)} SF`);
    R('Ceiling tiles', fmt(a.tiles, 0));
    R("Main tees (12')", fmt(a.mainPc, 0));
    R("4' cross tees", fmt(a.cross4, 0));
    if (a.cross2) R("2' cross tees", fmt(a.cross2, 0));
    R('Wall angle', `${fmt(a.anglePc, 0)} × 10' (${fmt(a.angleLF, 0)} LF)`);
    R('Hanger wire', fmt(a.hangers, 0));
  }
  rows.push('<div class="hint" style="margin:4px 0">Wall SF = length × height × sides, less opening deducts. Texture & paint cover the finished drywall; insulation is one batt layer per wall face. Prices in $ Bid.</div>');
  const body = $('dwBody');
  body.innerHTML = rows.join('');
  $('dwHeight').value = D.wallHeight; $('dwSheet').value = String(D.sheetSF); $('dwWaste').value = D.waste;
  $('dwCov').value = D.coverage; $('dwCoats').value = D.coats; $('dwFinish').value = D.finish;
  $('dwTexture').value = D.texture || 'none'; $('dwInsul').value = D.insul || 'none';
  const num = (el, key, min, def) => el.addEventListener('change', e => { D[key] = Math.max(min, parseFloat(e.target.value) || def); e.target.value = D[key]; scheduleSave(); renderDrywallPanel(); vp.requestDraw(); });
  num($('dwHeight'), 'wallHeight', 1, 9);
  num($('dwWaste'), 'waste', 0, 10);
  num($('dwCov'), 'coverage', 1, 375);
  num($('dwCoats'), 'coats', 1, 2);
  $('dwSheet').addEventListener('change', e => { D.sheetSF = parseFloat(e.target.value) || 32; scheduleSave(); renderDrywallPanel(); });
  $('dwFinish').addEventListener('change', e => { D.finish = e.target.value; scheduleSave(); renderDrywallPanel(); });
  $('dwTexture').addEventListener('change', e => { D.texture = e.target.value; scheduleSave(); renderDrywallPanel(); });
  $('dwInsul').addEventListener('change', e => { D.insul = e.target.value; scheduleSave(); renderDrywallPanel(); });
  // heights: set default / delete / start a measurement (listeners on fresh nodes — replaced each render, no accumulation)
  body.querySelectorAll('[data-huse]').forEach(el => el.addEventListener('click', () => { D.wallHeight = Math.max(1, parseFloat(el.dataset.huse) || D.wallHeight); scheduleSave(); renderDrywallPanel(); vp.requestDraw(); }));
  body.querySelectorAll('[data-hdel]').forEach(el => el.addEventListener('click', () => { const prev = snapshot(); state.markups = state.markups.filter(m => m.id !== el.dataset.hdel); pushUndo(prev); markupsChanged(); }));
  $('dwMeasureH').addEventListener('click', () => { setTool('dheight'); });
}
function syncDwInputs() { renderDrywallPanel(); }
$('btnDw').addEventListener('click', () => {
  const p = $('dwPanel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) { closeOtherPanels('dwPanel'); renderDrywallPanel(); }
  syncPanelButtons();
});
if ($('dwSidesSel')) $('dwSidesSel').addEventListener('change', e => {
  curDwSides = parseInt(e.target.value, 10) || 2;
  renderDrywallPanel();
  if (tool === 'dwall') setMsg(`New wall runs are ${curDwSides}-side.`);
});
if ($('dwCeilSel')) $('dwCeilSel').addEventListener('change', e => { curCeilType = e.target.value; if (tool === 'dceiling') setTool('dceiling'); });
if ($('dwOpeningSel')) $('dwOpeningSel').addEventListener('change', e => { curDwOpening = e.target.value; if (tool === 'dopening') setTool('dopening'); });
if ($('dwTrimSel')) $('dwTrimSel').addEventListener('change', e => { curDwTrim = e.target.value; if (tool === 'dtrim') setTool('dtrim'); });

/* ---- Flooring & Tile pack ---- */
const FLOOR_KINDS = ['tile', 'lvp', 'laminate', 'hardwood', 'carpet', 'vinyl', 'other'];
const TRANS_KINDS = ['threshold', 'reducer', 'tmolding', 'stairnose', 'seam', 'other'];
function flooringTotals() {
  const byType = {};      // ftype -> gross SF
  const transByType = {}; // ttype -> LF
  for (const m of state.markups) {
    if (m.kind === 'froom') { const t = (m.cfg && m.cfg.ftype) || 'tile'; byType[t] = (byType[t] || 0) + froomSf(m); }
    else if (m.kind === 'ftrans') { const t = (m.cfg && m.cfg.ttype) || 'reducer'; transByType[t] = (transByType[t] || 0) + ftransLenFt(m); }
  }
  let totalSF = 0;
  for (const k in byType) totalSF += byType[k];
  return { byType, transByType, totalSF };
}
// tile-setting materials from the tile floor SF (net of waste already applied):
// thinset by coverage; grout lbs by the tile size / joint / thickness formula
function tileMaterials(tileSF) {
  const F = state.flooring;
  const [L, W] = TILE_SIZE[F.tileSize] || [12, 12];
  const jw = GROUT_JOINT[F.groutJoint] != null ? GROUT_JOINT[F.groutJoint] : 0.1875;
  const cov = Number(F.thinsetCov) > 0 ? Number(F.thinsetCov) : 95;
  const groutRate = ((L + W) / (L * W)) * jw * TILE_THICK_IN * 14.5; // lbs / SF
  const groutLbs = tileSF * groutRate;
  return { thinsetBags: Math.ceil(tileSF / cov), groutLbs, groutBags: Math.ceil(groutLbs / 25) };
}
function flooringBidLines() {
  const T = flooringTotals();
  const F = state.flooring;
  const waste = 1 + (Number(F.waste) || 0) / 100;
  const lines = [];
  for (const k of FLOOR_KINDS) {
    const sf = T.byType[k];
    if (!sf || sf < 0.5) continue;
    lines.push({ key: `fl_${k}`, label: `${FLOOR_LABEL[k]} flooring (${F.waste}% waste)`, qty: sf * waste, unit: 'SF', q: 0, defPrice: FLOOR_PRICE[k] || 5 });
  }
  // tile-setting materials for the tile rooms
  const tileSF = (T.byType.tile || 0) * waste;
  if (tileSF > 0.5) {
    const tm = tileMaterials(tileSF);
    if (tm.thinsetBags > 0) lines.push({ key: 'fl_thinset', label: 'Thinset mortar', qty: tm.thinsetBags, unit: 'bag', q: 0, defPrice: 18 });
    if (tm.groutBags > 0) lines.push({ key: 'fl_grout', label: `Grout (${F.tileSize} tile, ${F.groutJoint}" joint)`, qty: tm.groutBags, unit: 'bag', q: 0, defPrice: 22 });
  }
  const underlay = F.underlay || 'none';
  if (underlay !== 'none' && T.totalSF > 0.5) lines.push({ key: 'fl_underlay', label: UNDERLAY_LABEL[underlay], qty: T.totalSF * waste, unit: 'SF', q: 0, defPrice: UNDERLAY_PRICE[underlay] || 0.5 });
  for (const k of TRANS_KINDS) {
    const lf = T.transByType[k];
    if (!lf || lf < 0.5) continue;
    lines.push({ key: `fl_trans_${k}`, label: `${TRANS_LABEL[k]} (transition)`, qty: lf, unit: 'LF', q: 0, defPrice: TRANS_PRICE[k] || 5 });
  }
  return lines;
}
function renderFlooringPanel() {
  const panel = $('floorPanel');
  if (!panel || panel.classList.contains('hidden')) return;
  const F = state.flooring;
  const T = flooringTotals();
  const rows = [];
  const R = (a, b) => rows.push(`<div class="dirt-row"><span>${a}</span><span class="v">${b}</span></div>`);
  const opts = FLOOR_KINDS.map(k => `<option value="${k}">${FLOOR_LABEL[k]}</option>`).join('');
  const uopts = ['none', 'foam', 'cork', 'cement', 'ditra'].map(k => `<option value="${k}">${UNDERLAY_LABEL[k]}</option>`).join('');
  const tsopts = Object.keys(TILE_SIZE).map(k => `<option value="${k}">${k}</option>`).join('');
  const gjopts = Object.keys(GROUT_JOINT).map(k => `<option value="${k}">${k}"</option>`).join('');
  rows.push('<div class="roof-sub">Settings</div>');
  rows.push(`<div class="dirt-set">New rooms <select id="flType">${opts}</select> · Waste <input type="number" id="flWaste" min="0"> %</div>`);
  rows.push(`<div class="dirt-set">Underlayment <select id="flUnder">${uopts}</select></div>`);
  rows.push(`<div class="dirt-set">Tile <select id="flTileSize">${tsopts}</select> · Grout joint <select id="flGrout">${gjopts}</select></div>`);
  rows.push('<div class="roof-sub">Floor SF by material</div>');
  let any = false;
  for (const k of FLOOR_KINDS) { const sf = T.byType[k]; if (!sf) continue; any = true; R(FLOOR_LABEL[k], `${fmt(sf, 0)} SF`); }
  if (!any) rows.push('<div class="hint" style="margin:4px 0">No rooms yet — trace a room (▦) and set its material.</div>');
  else {
    rows.push(`<div class="dirt-row"><b>Total floor SF</b><span class="v"><b>${fmt(T.totalSF, 0)}</b></span></div>`);
    if ((F.underlay || 'none') !== 'none') R(`Underlayment (${UNDERLAY_LABEL[F.underlay]})`, `${fmt(T.totalSF, 0)} SF`);
  }
  if (T.byType.tile) {
    const tm = tileMaterials((T.byType.tile) * (1 + (Number(F.waste) || 0) / 100));
    rows.push('<div class="roof-sub">Tile materials</div>');
    R('Thinset', `${fmt(tm.thinsetBags, 0)} bags`);
    R('Grout', `${fmt(tm.groutLbs, 0)} lb · ${fmt(tm.groutBags, 0)} bags`);
  }
  const transBits = TRANS_KINDS.filter(k => T.transByType[k] > 0.5);
  if (transBits.length) { rows.push('<div class="roof-sub">Transitions</div>'); for (const k of transBits) R(TRANS_LABEL[k], `${fmt(T.transByType[k], 0)} LF`); }
  rows.push('<div class="hint" style="margin:4px 0">Material SF adds waste; underlayment covers total floor SF. Thinset/grout for tile rooms. Prices in $ Bid.</div>');
  const body = $('floorBody');
  body.innerHTML = rows.join('');
  $('flType').value = curFloorType;
  $('flWaste').value = F.waste;
  $('flUnder').value = F.underlay || 'none';
  $('flTileSize').value = F.tileSize || '12x12';
  $('flGrout').value = F.groutJoint || '3/16';
  $('flType').addEventListener('change', e => { curFloorType = e.target.value; if (tool === 'froom') setTool('froom'); });
  $('flWaste').addEventListener('change', e => { F.waste = Math.max(0, parseFloat(e.target.value) || 10); e.target.value = F.waste; scheduleSave(); renderFlooringPanel(); vp.requestDraw(); });
  $('flUnder').addEventListener('change', e => { F.underlay = e.target.value; scheduleSave(); renderFlooringPanel(); });
  $('flTileSize').addEventListener('change', e => { F.tileSize = e.target.value; scheduleSave(); renderFlooringPanel(); });
  $('flGrout').addEventListener('change', e => { F.groutJoint = e.target.value; scheduleSave(); renderFlooringPanel(); });
}
$('btnFloor').addEventListener('click', () => {
  const p = $('floorPanel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) { closeOtherPanels('floorPanel'); renderFlooringPanel(); }
  syncPanelButtons();
});
if ($('flTypeTb')) $('flTypeTb').addEventListener('change', e => { curFloorType = e.target.value; if (tool === 'froom') setTool('froom'); });
if ($('flTransTb')) $('flTransTb').addEventListener('change', e => { curTransType = e.target.value; if (tool === 'ftrans') setTool('ftrans'); });

/* ---- Framing & Lumber pack ---- */
const FRAM_KINDS = ['2x4', '2x6', '2x8'];
function framingTotals() {
  const F = state.framing;
  const spacing = Number(F.spacing) > 0 ? Number(F.spacing) : 16;
  const height = Number(F.height) || 9;
  const plateFactor = 1 + (Number(F.topPlates) || 2); // bottom + top plate(s)
  const bySize = {}; // size -> { lf, studs, plateLF, bf }
  const openings = { door: 0, window: 0 };
  const sheathByType = {}; // stype -> SF
  let headerLF = 0, kingJack = 0, cripples = 0, sheathSF = 0;
  for (const m of state.markups) {
    if (m.kind === 'fsheath') { const t = (m.cfg && m.cfg.stype) || 'osb716'; const sf = fsheathSf(m); sheathByType[t] = (sheathByType[t] || 0) + sf; sheathSF += sf; continue; }
    if (m.kind === 'fwall') {
      const size = (m.cfg && m.cfg.size) || '2x4';
      const lf = fwallLenFt(m);
      if (lf < 0.01) continue;
      const g = bySize[size] || { lf: 0, studs: 0, plateLF: 0, bf: 0 };
      const studs = Math.ceil(lf * 12 / spacing) + 1;
      const plateLF = lf * plateFactor;
      g.lf += lf; g.studs += studs; g.plateLF += plateLF;
      g.bf += (studs * height + plateLF) * (FRAM_SIZE_BF[size] || 0.667);
      bySize[size] = g;
    } else if (m.kind === 'fopening') {
      const c = m.cfg || {};
      const n = m.pts.length;
      const w = Number(c.width) > 0 ? Number(c.width) : (FOPEN_W[c.otype] || 3);
      if (openings[c.otype] != null) openings[c.otype] += n;
      headerLF += n * (w + 0.5);          // + ~6" total bearing
      kingJack += n * 4;                   // 2 king + 2 jack per opening
      cripples += n * Math.ceil(w * 12 / spacing) * (c.otype === 'window' ? 2 : 1); // window: over header + under sill
    }
  }
  let totalLF = 0;
  for (const k in bySize) totalLF += bySize[k].lf;
  return { bySize, totalLF, openings, headerLF, kingJack, cripples, sheathByType, sheathSF };
}
const SHEATH_KINDS = ['osb716', 'ply12', 'ply58', 'zip'];
function framingBidLines() {
  const T = framingTotals();
  const lines = [];
  for (const k of FRAM_KINDS) {
    const g = T.bySize[k];
    if (!g || g.lf < 0.5) continue;
    lines.push({ key: `fr_stud_${k}`, label: `${FRAM_SIZE_LABEL[k]} studs (${state.framing.spacing}" OC)`, qty: g.studs, unit: 'EA', q: 0, defPrice: FRAM_STUD_PRICE[k] || 3.5 });
    lines.push({ key: `fr_plate_${k}`, label: `${FRAM_SIZE_LABEL[k]} plate lumber`, qty: g.plateLF, unit: 'LF', q: 0, defPrice: FRAM_PLATE_PRICE[k] || 0.9 });
  }
  if (T.headerLF > 0.5) lines.push({ key: 'fr_header', label: 'Header lumber (openings)', qty: T.headerLF, unit: 'LF', q: 0, defPrice: 2.5 });
  if (T.kingJack > 0) lines.push({ key: 'fr_openstud', label: 'Opening studs (king + jack)', qty: T.kingJack, unit: 'EA', q: 0, defPrice: 3.5 });
  if (T.cripples > 0) lines.push({ key: 'fr_cripple', label: 'Cripple studs', qty: T.cripples, unit: 'EA', q: 0, defPrice: 2 });
  const sw = 1 + (Number(state.framing.sheathWaste) || 0) / 100;
  for (const k of SHEATH_KINDS) {
    const sf = T.sheathByType[k];
    if (!sf || sf < 0.5) continue;
    lines.push({ key: `fr_sheath_${k}`, label: `${SHEATH_LABEL[k]} sheathing (4×8 sheets)`, qty: Math.ceil(sf * sw / 32), unit: 'sheet', q: 0, defPrice: SHEATH_PRICE[k] || 15 });
  }
  if (T.sheathSF > 0.5) lines.push({ key: 'fr_sheath_nails', label: 'Sheathing nails', qty: Math.max(1, Math.round(T.sheathSF * 0.008)), unit: 'lb', q: 0, defPrice: 2 });
  if (T.totalLF > 0.5) lines.push({ key: 'fr_labor', label: 'Wall framing (labor)', qty: T.totalLF, unit: 'LF', q: 0, defPrice: 8 });
  return lines;
}
function renderFramingPanel() {
  const panel = $('framPanel');
  if (!panel || panel.classList.contains('hidden')) return;
  const F = state.framing;
  const T = framingTotals();
  const rows = [];
  const R = (a, b) => rows.push(`<div class="dirt-row"><span>${a}</span><span class="v">${b}</span></div>`);
  const szOpts = FRAM_KINDS.map(k => `<option value="${k}">${FRAM_SIZE_LABEL[k]}</option>`).join('');
  rows.push('<div class="roof-sub">Settings</div>');
  rows.push(`<div class="dirt-set">New walls <select id="frSize">${szOpts}</select> · Spacing <select id="frSpacing"><option value="16">16" OC</option><option value="24">24" OC</option></select></div>`);
  rows.push('<div class="dirt-set">Wall height <input type="number" id="frHeight" min="1" step="0.5"> ft · Top plates <select id="frTop"><option value="1">Single</option><option value="2">Double</option></select></div>');
  const shOpts = SHEATH_KINDS.map(k => `<option value="${k}">${SHEATH_LABEL[k]}</option>`).join('');
  rows.push(`<div class="dirt-set">Sheathing <select id="frSheath">${shOpts}</select> · Waste <input type="number" id="frShWaste" min="0"> %</div>`);
  rows.push('<div class="roof-sub">By stud size</div>');
  let any = false;
  for (const k of FRAM_KINDS) {
    const g = T.bySize[k]; if (!g) continue; any = true;
    rows.push(`<div class="roof-sub" style="opacity:.8">${FRAM_SIZE_LABEL[k]} — ${fmt(g.lf, 0)} LF</div>`);
    R('Studs', `${fmt(g.studs, 0)} EA`);
    R('Plate lumber', `${fmt(g.plateLF, 0)} LF`);
    R('Board-feet', `${fmt(g.bf, 0)} BF`);
  }
  if (!any) rows.push('<div class="hint" style="margin:4px 0">No walls yet — trace a wall run (‖) and set its stud size.</div>');
  else rows.push(`<div class="dirt-row"><b>Total wall LF</b><span class="v"><b>${fmt(T.totalLF, 0)}</b></span></div>`);
  if (T.openings.door || T.openings.window) {
    rows.push('<div class="roof-sub">Openings</div>');
    R('Doors · windows', `${T.openings.door} · ${T.openings.window}`);
    R('Header lumber', `${fmt(T.headerLF, 0)} LF`);
    R('King + jack studs', `${fmt(T.kingJack, 0)} EA`);
    R('Cripple studs', `${fmt(T.cripples, 0)} EA`);
  }
  if (T.sheathSF > 0.5) {
    const shw = 1 + (Number(F.sheathWaste) || 0) / 100;
    rows.push('<div class="roof-sub">Sheathing</div>');
    for (const k of SHEATH_KINDS) { const sf = T.sheathByType[k]; if (!sf) continue; R(SHEATH_LABEL[k], `${fmt(sf, 0)} SF · ${fmt(Math.ceil(sf * shw / 32), 0)} sheets`); }
  }
  rows.push('<div class="hint" style="margin:4px 0">Studs = ⌈LF·12/spacing⌉+1; plates = LF × (1 + top plates); openings add header + king/jack/cripple; sheathing → 4×8 sheets. Prices in $ Bid.</div>');
  const body = $('framBody');
  body.innerHTML = rows.join('');
  $('frSize').value = curFramSize;
  $('frSpacing').value = String(F.spacing);
  $('frHeight').value = F.height;
  $('frTop').value = String(F.topPlates);
  $('frSheath').value = curSheathType;
  $('frShWaste').value = F.sheathWaste != null ? F.sheathWaste : 10;
  $('frSize').addEventListener('change', e => { curFramSize = e.target.value; if (tool === 'fwall') setTool('fwall'); });
  $('frSpacing').addEventListener('change', e => { F.spacing = parseInt(e.target.value, 10) || 16; scheduleSave(); renderFramingPanel(); if (tool === 'fwall') setTool('fwall'); });
  $('frHeight').addEventListener('change', e => { F.height = Math.max(1, parseFloat(e.target.value) || 9); e.target.value = F.height; scheduleSave(); renderFramingPanel(); if (tool === 'fwall') setTool('fwall'); });
  $('frTop').addEventListener('change', e => { F.topPlates = parseInt(e.target.value, 10) || 2; scheduleSave(); renderFramingPanel(); });
  $('frSheath').addEventListener('change', e => { curSheathType = e.target.value; if (tool === 'fsheath') setTool('fsheath'); });
  $('frShWaste').addEventListener('change', e => { F.sheathWaste = Math.max(0, parseFloat(e.target.value) || 10); e.target.value = F.sheathWaste; scheduleSave(); renderFramingPanel(); });
}
$('btnFram').addEventListener('click', () => {
  const p = $('framPanel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) { closeOtherPanels('framPanel'); renderFramingPanel(); }
  syncPanelButtons();
});
if ($('frSizeTb')) $('frSizeTb').addEventListener('change', e => { curFramSize = e.target.value; if (tool === 'fwall') setTool('fwall'); });
if ($('frOpenTb')) $('frOpenTb').addEventListener('change', e => { curFopenType = e.target.value; if (tool === 'fopening') setTool('fopening'); });
if ($('frSheathTb')) $('frSheathTb').addEventListener('change', e => { curSheathType = e.target.value; if (tool === 'fsheath') setTool('fsheath'); });

/* ---- Erosion & Sediment Control pack ---- */
function escTotals() {
  const byLine = {}; // ltype -> LF
  const byItem = {}; // itype -> EA
  const byArea = {}; // atype -> SF
  let lineLF = 0, itemEA = 0, areaSF = 0;
  for (const m of state.markups) {
    if (m.kind === 'escarea') {
      const t = (m.cfg && m.cfg.atype) || 'entrance';
      const sf = escareaSf(m);
      if (sf < 0.01) continue;
      byArea[t] = (byArea[t] || 0) + sf;
      areaSF += sf;
      continue;
    }
    if (m.kind === 'escitem') {
      const t = (m.cfg && m.cfg.itype) || 'inletdrop';
      const n = m.pts.length;
      byItem[t] = (byItem[t] || 0) + n;
      itemEA += n;
      continue;
    }
    if (m.kind !== 'escline') continue;
    const t = (m.cfg && m.cfg.ltype) || 'silt';
    const lf = esclineLenFt(m);
    if (lf < 0.01) continue;
    byLine[t] = (byLine[t] || 0) + lf;
    lineLF += lf;
  }
  return { byLine, lineLF, byItem, itemEA, byArea, areaSF };
}
// Area material math, shared by the bid and the panel so they can't drift.
// Intl of the numbers aside, the conversions are the standard ones: stone by
// depth x density, blanket by SY with overlap waste, seed/mulch by acre.
function escMaterials(T) {
  const E = state.esc || {};
  const sf = t => T.byArea[t] || 0;
  const density = Number(E.stoneDensity) > 0 ? Number(E.stoneDensity) : 105; // lb/ft³
  const entCF = sf('entrance') * ((Number(E.entranceDepth) || 6) / 12);
  const ripCF = sf('riprap') * ((Number(E.riprapDepth) || 12) / 12);
  const acres = sf('seed') / SF_PER_ACRE;
  return {
    entranceCY: entCF / CF_PER_CY,
    entranceTons: entCF * density / LB_PER_TON,
    riprapCY: ripCF / CF_PER_CY,
    riprapTons: ripCF * density / LB_PER_TON,
    blanketSY: sf('blanket') * (1 + (Number(E.blanketWaste) || 0) / 100) / SF_PER_SY,
    acres,
    seedLbs: acres * (Number(E.seedRate) || 0),
    mulchTons: acres * (Number(E.mulchRate) || 0),
  };
}
function escBidLines() {
  const T = escTotals();
  const lines = [];
  // ESC is bid at installed unit prices ($/LF), so there's no separate labor
  // line the way framing has one — labor is inside each type's rate.
  for (const k of ESC_LINE_KINDS) {
    const lf = T.byLine[k];
    if (!lf || lf < 0.5) continue;
    lines.push({ key: `esc_line_${k}`, label: `${ESC_LINE_LABEL[k]} (installed)`, qty: lf, unit: 'LF', q: 0, defPrice: ESC_LINE_PRICE[k] || 2.5 });
  }
  for (const k of ESC_ITEM_KINDS) {
    const ea = T.byItem[k];
    if (!ea) continue;
    lines.push({ key: `esc_item_${k}`, label: `${ESC_ITEM_LABEL[k]} (installed)`, qty: ea, unit: 'EA', q: 0, defPrice: ESC_ITEM_PRICE[k] || 150 });
  }
  const M = escMaterials(T);
  if (M.entranceTons > 0.01) lines.push({ key: 'esc_entrance_stone', label: `Construction entrance stone (${fmt(state.esc.entranceDepth || 6, 0)}" deep)`, qty: M.entranceTons, unit: 'ton', q: 0, defPrice: 35 });
  if (M.blanketSY > 0.5) lines.push({ key: 'esc_blanket', label: 'Erosion blanket (incl. staples)', qty: M.blanketSY, unit: 'SY', q: 0, defPrice: 1.75 });
  if (M.seedLbs > 0.01) lines.push({ key: 'esc_seed', label: `Seed (${fmt(state.esc.seedRate || 0, 0)} lb/ac)`, qty: M.seedLbs, unit: 'lb', q: 0, defPrice: 4 });
  if (M.mulchTons > 0.01) lines.push({ key: 'esc_mulch', label: `Mulch (${fmt(state.esc.mulchRate || 0, 1)} ton/ac)`, qty: M.mulchTons, unit: 'ton', q: 0, defPrice: 200 });
  if (M.riprapTons > 0.01) lines.push({ key: 'esc_riprap', label: `Riprap / outlet protection (${fmt(state.esc.riprapDepth || 12, 0)}" deep)`, qty: M.riprapTons, unit: 'ton', q: 0, defPrice: 55 });
  return lines;
}
function renderEscPanel() {
  const panel = $('escPanel');
  if (!panel || panel.classList.contains('hidden')) return;
  const T = escTotals();
  const rows = [];
  const R = (a, b) => rows.push(`<div class="dirt-row"><span>${a}</span><span class="v">${b}</span></div>`);
  const lnOpts = ESC_LINE_KINDS.map(k => `<option value="${k}">${ESC_LINE_LABEL[k]}</option>`).join('');
  rows.push('<div class="roof-sub">Settings</div>');
  rows.push(`<div class="dirt-set">New runs <select id="escLine">${lnOpts}</select></div>`);
  const itOpts = ESC_ITEM_KINDS.map(k => `<option value="${k}">${ESC_ITEM_LABEL[k]}</option>`).join('');
  rows.push(`<div class="dirt-set">New BMPs <select id="escItem">${itOpts}</select></div>`);
  const arOpts = ESC_AREA_KINDS.map(k => `<option value="${k}">${ESC_AREA_LABEL[k]}</option>`).join('');
  rows.push(`<div class="dirt-set">New areas <select id="escArea">${arOpts}</select></div>`);
  // Rate inputs appear only for the area types actually traced — six numeric
  // fields on a panel with no areas is just noise.
  const A = T.byArea;
  if (A.entrance) rows.push('<div class="dirt-set">Entrance stone <input type="number" id="escEntDepth" min="1" step="1" style="width:46px"> in deep</div>');
  if (A.riprap) rows.push('<div class="dirt-set">Riprap <input type="number" id="escRipDepth" min="1" step="1" style="width:46px"> in deep</div>');
  if (A.entrance || A.riprap) rows.push('<div class="dirt-set">Stone density <input type="number" id="escDensity" min="1" step="1" style="width:52px"> lb/ft³</div>');
  if (A.blanket) rows.push('<div class="dirt-set">Blanket overlap waste <input type="number" id="escBlWaste" min="0" step="1" style="width:46px"> %</div>');
  if (A.seed) rows.push('<div class="dirt-set">Seed <input type="number" id="escSeedRate" min="0" step="1" style="width:52px"> lb/ac · Mulch <input type="number" id="escMulchRate" min="0" step="0.1" style="width:46px"> ton/ac</div>');
  rows.push('<div class="roof-sub">Perimeter controls</div>');
  let any = false;
  for (const k of ESC_LINE_KINDS) {
    const lf = T.byLine[k];
    if (!lf) continue;
    any = true;
    R(ESC_LINE_LABEL[k], `${fmt(lf, 0)} LF`);
  }
  if (!any) rows.push('<div class="hint" style="margin:4px 0">No controls yet — trace a run (〰) and set its type.</div>');
  else rows.push(`<div class="dirt-row"><b>Total</b><span class="v"><b>${fmt(T.lineLF, 0)} LF</b></span></div>`);
  if (T.itemEA > 0) {
    rows.push('<div class="roof-sub">Point controls</div>');
    for (const k of ESC_ITEM_KINDS) { const ea = T.byItem[k]; if (!ea) continue; R(ESC_ITEM_LABEL[k], `${ea} EA`); }
    rows.push(`<div class="dirt-row"><b>Total</b><span class="v"><b>${T.itemEA} EA</b></span></div>`);
  }
  if (T.areaSF > 0.5) {
    const M = escMaterials(T);
    rows.push('<div class="roof-sub">Stabilized areas</div>');
    for (const k of ESC_AREA_KINDS) { const sf = T.byArea[k]; if (!sf) continue; R(ESC_AREA_LABEL[k], `${fmt(sf, 0)} SF`); }
    rows.push('<div class="roof-sub" style="opacity:.8">Materials</div>');
    if (T.byArea.entrance) R('Entrance stone', `${fmt(M.entranceCY, 1)} CY · ${fmt(M.entranceTons, 1)} tons`);
    if (T.byArea.riprap) R('Riprap', `${fmt(M.riprapCY, 1)} CY · ${fmt(M.riprapTons, 1)} tons`);
    if (T.byArea.blanket) R('Erosion blanket', `${fmt(M.blanketSY, 0)} SY`);
    if (T.byArea.seed) { R('Seeded area', `${fmt(M.acres, 2)} ac`); R('Seed · mulch', `${fmt(M.seedLbs, 0)} lb · ${fmt(M.mulchTons, 1)} ton`); }
  }
  rows.push('<div class="hint" style="margin:4px 0">Each control rolls up by type at its installed unit price (labor included) — runs by LF, BMPs by EA, areas by SF into stone tons / SY / seed & mulch. Double-click one to change its type. Prices in $ Bid.</div>');
  $('escBody').innerHTML = rows.join('');
  const E = state.esc;
  $('escLine').value = curEscLine;
  $('escItem').value = curEscItem;
  $('escArea').value = curEscArea;
  $('escLine').addEventListener('change', e => { curEscLine = e.target.value; if (tool === 'escline') setTool('escline'); });
  $('escItem').addEventListener('change', e => { curEscItem = e.target.value; if (tool === 'escitem') setTool('escitem'); });
  $('escArea').addEventListener('change', e => { curEscArea = e.target.value; if (tool === 'escarea') setTool('escarea'); });
  // the rate inputs are conditional, so bind defensively
  const num = (id, key, def, min) => {
    const el = $(id);
    if (!el) return;
    el.value = E[key] != null ? E[key] : def;
    el.addEventListener('change', ev => {
      E[key] = Math.max(min, parseFloat(ev.target.value) || def);
      ev.target.value = E[key];
      scheduleSave(); renderEscPanel();
    });
  };
  num('escEntDepth', 'entranceDepth', 6, 1);
  num('escRipDepth', 'riprapDepth', 12, 1);
  num('escDensity', 'stoneDensity', 105, 1);
  num('escBlWaste', 'blanketWaste', 10, 0);
  num('escSeedRate', 'seedRate', 200, 0);
  num('escMulchRate', 'mulchRate', 2, 0);
}
$('btnEsc').addEventListener('click', () => {
  const p = $('escPanel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) { closeOtherPanels('escPanel'); renderEscPanel(); }
  syncPanelButtons();
});
if ($('escLineTb')) $('escLineTb').addEventListener('change', e => { curEscLine = e.target.value; if (tool === 'escline') setTool('escline'); });
if ($('escItemTb')) $('escItemTb').addEventListener('change', e => { curEscItem = e.target.value; if (tool === 'escitem') setTool('escitem'); });
if ($('escAreaTb')) $('escAreaTb').addEventListener('change', e => { curEscArea = e.target.value; if (tool === 'escarea') setTool('escarea'); });

/* ---- Striping & Signage pack ---- */
function stripingTotals() {
  const byLine = {}; // stype -> LF
  const byStall = {}; // ttype -> EA
  const byMark = {}; // mtype -> EA
  let lineLF = 0, stalls = 0, adaStalls = 0, marks = 0;
  for (const m of state.markups) {
    if (m.kind === 'smark') {
      const t = (m.cfg && m.cfg.mtype) || 'arrow';
      const n = m.pts.length;
      byMark[t] = (byMark[t] || 0) + n;
      marks += n;
      continue;
    }
    if (m.kind === 'sstall') {
      const t = (m.cfg && m.cfg.ttype) || 'standard';
      const n = m.pts.length;
      byStall[t] = (byStall[t] || 0) + n;
      stalls += n;
      if (STRP_STALL_ADA[t]) adaStalls += n;
      continue;
    }
    if (m.kind !== 'sstripe') continue;
    const t = (m.cfg && m.cfg.stype) || 'line4';
    const lf = sstripeLenFt(m);
    if (lf < 0.01) continue;
    byLine[t] = (byLine[t] || 0) + lf;
    lineLF += lf;
  }
  return { byLine, lineLF, byStall, stalls, adaStalls, byMark, marks };
}
// Paint + glass beads, from the WIDTH-WEIGHTED stripe LF: a 24" stop bar eats
// six times the paint of a 4" line per foot, so everything is converted to
// "4-inch-equivalent LF" first.
//
// This is a COST BASIS for the panel, deliberately not bid lines — the $/LF and
// $/EA above are installed prices that already include paint, so adding gallons
// to the bid would charge for it twice. (Same call as the framing pack's
// board-feet.)
function stripingPaint(T) {
  const S = state.striping || {};
  const cov = Number(S.coverage4in) > 0 ? Number(S.coverage4in) : 320; // LF of 4" line per gallon
  const coats = Number(S.coats) > 0 ? Number(S.coats) : 1;
  let eq4 = 0;
  for (const k of STRP_LINE_KINDS) {
    const lf = T.byLine[k] || 0;
    eq4 += lf * ((STRP_LINE_WIDTH[k] || 4) / 4);
  }
  const gallons = cov > 0 ? eq4 / cov * coats : 0;
  return { eq4, gallons, beadLbs: gallons * (Number(S.beadRate) || 0) };
}
function stripingBidLines() {
  const T = stripingTotals();
  const lines = [];
  // Everything is an installed unit price — a stall's price already includes
  // painting its own lines, which is why stall lines aren't traced as runs.
  for (const k of STRP_STALL_KINDS) {
    const ea = T.byStall[k];
    if (!ea) continue;
    lines.push({ key: `strp_stall_${k}`, label: `${STRP_STALL_LABEL[k]} (striped)`, qty: ea, unit: 'EA', q: 0, defPrice: STRP_STALL_PRICE[k] || 5 });
  }
  for (const k of STRP_LINE_KINDS) {
    const lf = T.byLine[k];
    if (!lf || lf < 0.5) continue;
    lines.push({ key: `strp_line_${k}`, label: `${STRP_LINE_LABEL[k]} (painted)`, qty: lf, unit: 'LF', q: 0, defPrice: STRP_LINE_PRICE[k] || 0.35 });
  }
  for (const k of STRP_MARK_KINDS) {
    const ea = T.byMark[k];
    if (!ea) continue;
    lines.push({ key: `strp_mark_${k}`, label: `${STRP_MARK_LABEL[k]} (installed)`, qty: ea, unit: 'EA', q: 0, defPrice: STRP_MARK_PRICE[k] || 35 });
  }
  return lines;
}
function renderStripingPanel() {
  const panel = $('strpPanel');
  if (!panel || panel.classList.contains('hidden')) return;
  const T = stripingTotals();
  const rows = [];
  const R = (a, b) => rows.push(`<div class="dirt-row"><span>${a}</span><span class="v">${b}</span></div>`);
  const stOpts = STRP_STALL_KINDS.map(k => `<option value="${k}">${STRP_STALL_LABEL[k]}</option>`).join('');
  const lnOpts = STRP_LINE_KINDS.map(k => `<option value="${k}">${STRP_LINE_LABEL[k]}</option>`).join('');
  rows.push('<div class="roof-sub">Settings</div>');
  rows.push(`<div class="dirt-set">New stalls <select id="strpStall">${stOpts}</select></div>`);
  rows.push(`<div class="dirt-set">New runs <select id="strpLine">${lnOpts}</select></div>`);
  const mkOpts = STRP_MARK_KINDS.map(k => `<option value="${k}">${STRP_MARK_LABEL[k]}</option>`).join('');
  rows.push(`<div class="dirt-set">New markings <select id="strpMark">${mkOpts}</select></div>`);
  if (T.stalls > 0) {
    rows.push('<div class="roof-sub">Stalls</div>');
    for (const k of STRP_STALL_KINDS) { const ea = T.byStall[k]; if (!ea) continue; R(STRP_STALL_LABEL[k], `${ea} EA`); }
    rows.push(`<div class="dirt-row"><b>Total stalls</b><span class="v"><b>${T.stalls}</b></span></div>`);
    // ADA count is the number that gets a lot rejected, so it gets its own line
    // rather than being buried in the per-type list.
    R('of which ADA', `${T.adaStalls} (${T.stalls ? fmt(T.adaStalls / T.stalls * 100, 1) : '0'}%)`);
  }
  if (T.lineLF > 0.5) {
    rows.push('<div class="roof-sub">Painted runs</div>');
    for (const k of STRP_LINE_KINDS) { const lf = T.byLine[k]; if (!lf) continue; R(STRP_LINE_LABEL[k], `${fmt(lf, 0)} LF`); }
    rows.push(`<div class="dirt-row"><b>Total</b><span class="v"><b>${fmt(T.lineLF, 0)} LF</b></span></div>`);
  }
  if (T.marks > 0) {
    rows.push('<div class="roof-sub">Markings & signs</div>');
    for (const k of STRP_MARK_KINDS) { const ea = T.byMark[k]; if (!ea) continue; R(STRP_MARK_LABEL[k], `${ea} EA`); }
    rows.push(`<div class="dirt-row"><b>Total</b><span class="v"><b>${T.marks} EA</b></span></div>`);
  }
  if (!T.stalls && !T.marks && T.lineLF < 0.5) rows.push('<div class="hint" style="margin:4px 0">Nothing yet — count stalls (⊞), trace a run (≡), or drop markings (◆).</div>');
  if (T.lineLF > 0.5) {
    const P = stripingPaint(T);
    const S = state.striping;
    rows.push('<div class="roof-sub">Paint (cost basis)</div>');
    rows.push('<div class="dirt-set">Coverage <input type="number" id="strpCov" min="1" step="10" style="width:56px"> LF/gal of 4" · Coats <select id="strpCoats"><option value="1">1</option><option value="2">2</option></select></div>');
    rows.push('<div class="dirt-set">Glass beads <input type="number" id="strpBead" min="0" step="0.5" style="width:46px"> lb/gal</div>');
    R('4"-equivalent LF', `${fmt(P.eq4, 0)} LF`);
    R('Paint', `${fmt(P.gallons, 1)} gal`);
    if (P.beadLbs > 0) R('Glass beads', `${fmt(P.beadLbs, 0)} lb`);
    rows.push('<div class="hint" style="margin:4px 0">A cost basis only — not on the bid. The $/LF and $/EA rates are installed prices that already include paint, so billing gallons too would charge for it twice.</div>');
  }
  rows.push('<div class="hint" style="margin:4px 0"><b>Don’t trace stall lines.</b> A stall’s price already includes painting its own lines — trace only the runs that aren’t stall lines (stop bars, crosswalks, lane lines, hatching), or the paint gets charged twice. Prices in $ Bid.</div>');
  $('strpBody').innerHTML = rows.join('');
  $('strpStall').value = curStrpStall;
  $('strpLine').value = curStrpLine;
  $('strpMark').value = curStrpMark;
  $('strpStall').addEventListener('change', e => { curStrpStall = e.target.value; if (tool === 'sstall') setTool('sstall'); });
  $('strpLine').addEventListener('change', e => { curStrpLine = e.target.value; if (tool === 'sstripe') setTool('sstripe'); });
  $('strpMark').addEventListener('change', e => { curStrpMark = e.target.value; if (tool === 'smark') setTool('smark'); });
  // the paint inputs only render when there are runs, so bind defensively
  const S = state.striping;
  if ($('strpCov')) {
    $('strpCov').value = S.coverage4in != null ? S.coverage4in : 320;
    $('strpCov').addEventListener('change', e => { S.coverage4in = Math.max(1, parseFloat(e.target.value) || 320); e.target.value = S.coverage4in; scheduleSave(); renderStripingPanel(); });
  }
  if ($('strpCoats')) {
    $('strpCoats').value = String(S.coats || 1);
    $('strpCoats').addEventListener('change', e => { S.coats = parseInt(e.target.value, 10) || 1; scheduleSave(); renderStripingPanel(); });
  }
  if ($('strpBead')) {
    $('strpBead').value = S.beadRate != null ? S.beadRate : 6;
    $('strpBead').addEventListener('change', e => { S.beadRate = Math.max(0, parseFloat(e.target.value) || 0); e.target.value = S.beadRate; scheduleSave(); renderStripingPanel(); });
  }
}
$('btnStrp').addEventListener('click', () => {
  const p = $('strpPanel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) { closeOtherPanels('strpPanel'); renderStripingPanel(); }
  syncPanelButtons();
});
if ($('strpStallTb')) $('strpStallTb').addEventListener('change', e => { curStrpStall = e.target.value; if (tool === 'sstall') setTool('sstall'); });
if ($('strpLineTb')) $('strpLineTb').addEventListener('change', e => { curStrpLine = e.target.value; if (tool === 'sstripe') setTool('sstripe'); });
if ($('strpMarkTb')) $('strpMarkTb').addEventListener('change', e => { curStrpMark = e.target.value; if (tool === 'smark') setTool('smark'); });

/* ---- Siding, Gutters & Insulation pack ---- */
function sidingTotals() {
  const byMat = {}; // mat -> gross SF
  const openCounts = {}; // otype -> EA
  const byGut = {}; // gtype -> LF
  const byIns = {}; // itype -> SF
  let grossSF = 0, deductSF = 0, openings = 0, gutLF = 0, insSF = 0;
  for (const m of state.markups) {
    if (m.kind === 'sgutter') {
      const t = (m.cfg && m.cfg.gtype) || 'k5';
      const lf = sgutterLenFt(m);
      if (lf < 0.01) continue;
      byGut[t] = (byGut[t] || 0) + lf;
      gutLF += lf;
      continue;
    }
    if (m.kind === 'sinsul') {
      const t = (m.cfg && m.cfg.itype) || 'battR13';
      const sf = sinsulSf(m);
      if (sf < 0.01) continue;
      byIns[t] = (byIns[t] || 0) + sf;
      insSF += sf;
      continue;
    }
    if (m.kind === 'sopening') {
      const c = m.cfg || {};
      const n = m.pts.length;
      openCounts[c.otype] = (openCounts[c.otype] || 0) + n;
      openings += n;
      deductSF += n * (Number(c.deductSF) || 0);
      continue;
    }
    if (m.kind !== 'swall') continue;
    const mat = (m.cfg && m.cfg.mat) || 'vinyl';
    const sf = swallSf(m);
    if (sf < 0.01) continue;
    byMat[mat] = (byMat[mat] || 0) + sf;
    grossSF += sf;
  }
  // Openings aren't tied to a wall, so the deduction is applied to the whole
  // elevation set and split across materials by their share of gross. On a
  // single-material job (the common case) that's exact; on a mixed one it's the
  // honest approximation, and the panel shows gross/deduct/net so it's visible.
  const netSF = Math.max(0, grossSF - deductSF);
  const netByMat = {};
  for (const k in byMat) {
    netByMat[k] = grossSF > 0 ? byMat[k] / grossSF * netSF : 0;
  }
  return { byMat, netByMat, grossSF, deductSF, netSF, openCounts, openings, byGut, gutLF, byIns, insSF };
}
function sidingBidLines() {
  const T = sidingTotals();
  const lines = [];
  const waste = 1 + (Number(state.siding.waste) || 0) / 100;
  for (const k of SID_MAT_KINDS) {
    const sf = T.netByMat[k];
    if (!sf || sf < 0.5) continue;
    lines.push({ key: `sid_mat_${k}`, label: `${SID_MAT_LABEL[k]} (net + ${fmt(state.siding.waste || 0, 0)}% waste)`, qty: sf * waste, unit: 'SF', q: 0, defPrice: SID_MAT_PRICE[k] || 4.5 });
  }
  for (const k of SID_OPEN_KINDS) {
    const ea = T.openCounts[k];
    if (!ea) continue;
    lines.push({ key: `sid_open_${k}`, label: `${SID_OPEN_LABEL[k]} trim & wrap`, qty: ea, unit: 'EA', q: 0, defPrice: SID_OPEN_PRICE[k] || 65 });
  }
  for (const k of SID_GUT_KINDS) {
    const lf = T.byGut[k];
    if (!lf || lf < 0.5) continue;
    lines.push({ key: `sid_gut_${k}`, label: `${SID_GUT_LABEL[k]} (installed)`, qty: lf, unit: 'LF', q: 0, defPrice: SID_GUT_PRICE[k] || 9 });
  }
  const iw = 1 + (Number(state.siding.insulWaste) || 0) / 100;
  for (const k of SID_INS_KINDS) {
    const sf = T.byIns[k];
    if (!sf || sf < 0.5) continue;
    lines.push({ key: `sid_ins_${k}`, label: `${SID_INS_LABEL[k]} (+${fmt(state.siding.insulWaste || 0, 0)}% waste)`, qty: sf * iw, unit: 'SF', q: 0, defPrice: SID_INS_PRICE[k] || 0.95 });
  }
  return lines;
}
function renderSidingPanel() {
  const panel = $('sidPanel');
  if (!panel || panel.classList.contains('hidden')) return;
  const S = state.siding;
  const T = sidingTotals();
  const rows = [];
  const R = (a, b) => rows.push(`<div class="dirt-row"><span>${a}</span><span class="v">${b}</span></div>`);
  const matOpts = SID_MAT_KINDS.map(k => `<option value="${k}">${SID_MAT_LABEL[k]}</option>`).join('');
  const opOpts = SID_OPEN_KINDS.map(k => `<option value="${k}">${SID_OPEN_LABEL[k]}</option>`).join('');
  rows.push('<div class="roof-sub">Settings</div>');
  rows.push(`<div class="dirt-set">New walls <select id="sidMat">${matOpts}</select> · Waste <input type="number" id="sidWaste" min="0" step="1" style="width:44px"> %</div>`);
  rows.push(`<div class="dirt-set">New openings <select id="sidOpen">${opOpts}</select></div>`);
  const gutOpts = SID_GUT_KINDS.map(k => `<option value="${k}">${SID_GUT_LABEL[k]}</option>`).join('');
  rows.push(`<div class="dirt-set">New gutters <select id="sidGut">${gutOpts}</select></div>`);
  const insOpts = SID_INS_KINDS.map(k => `<option value="${k}">${SID_INS_LABEL[k]}</option>`).join('');
  rows.push(`<div class="dirt-set">New insulation <select id="sidIns">${insOpts}</select></div>`);
  if (T.grossSF > 0.5) {
    // Gross / deduct / net side by side: the deduction is the thing most likely
    // to be wrong, so it's shown rather than silently folded into the total.
    rows.push('<div class="roof-sub">Wall area</div>');
    R('Gross', `${fmt(T.grossSF, 0)} SF`);
    R('Openings deduct', `−${fmt(T.deductSF, 0)} SF`);
    rows.push(`<div class="dirt-row"><b>Net</b><span class="v"><b>${fmt(T.netSF, 0)} SF · ${fmt(T.netSF / SF_PER_SQUARE, 1)} sq</b></span></div>`);
    const waste = 1 + (Number(S.waste) || 0) / 100;
    rows.push('<div class="roof-sub">By material (net + waste)</div>');
    for (const k of SID_MAT_KINDS) {
      const sf = T.netByMat[k];
      if (!sf || sf < 0.5) continue;
      R(SID_MAT_LABEL[k], `${fmt(sf * waste, 0)} SF · ${fmt(sf * waste / SF_PER_SQUARE, 1)} sq`);
    }
  }
  if (T.openings > 0) {
    rows.push('<div class="roof-sub">Openings</div>');
    for (const k of SID_OPEN_KINDS) { const ea = T.openCounts[k]; if (!ea) continue; R(SID_OPEN_LABEL[k], `${ea} EA`); }
    rows.push(`<div class="dirt-row"><b>Total</b><span class="v"><b>${T.openings} EA</b></span></div>`);
  }
  if (T.gutLF > 0.5) {
    rows.push('<div class="roof-sub">Gutters & downspouts</div>');
    for (const k of SID_GUT_KINDS) { const lf = T.byGut[k]; if (!lf) continue; R(SID_GUT_LABEL[k], `${fmt(lf, 0)} LF`); }
    rows.push(`<div class="dirt-row"><b>Total</b><span class="v"><b>${fmt(T.gutLF, 0)} LF</b></span></div>`);
  }
  if (T.insSF > 0.5) {
    const iw = 1 + (Number(S.insulWaste) || 0) / 100;
    const cov = Number(S.battCoverage) > 0 ? Number(S.battCoverage) : 88;
    rows.push('<div class="roof-sub">Insulation</div>');
    rows.push('<div class="dirt-set">Waste <input type="number" id="sidInsWaste" min="0" step="1" style="width:44px"> % · Batt coverage <input type="number" id="sidBattCov" min="1" step="1" style="width:48px"> SF/bag</div>');
    for (const k of SID_INS_KINDS) {
      const sf = T.byIns[k];
      if (!sf) continue;
      // only batts convert to bags; blown/foam are bid straight by SF
      const bags = SID_INS_BAGGED[k] ? ` · ${fmt(Math.ceil(sf * iw / cov), 0)} bags` : '';
      R(SID_INS_LABEL[k], `${fmt(sf * iw, 0)} SF${bags}`);
    }
    rows.push(`<div class="dirt-row"><b>Total</b><span class="v"><b>${fmt(T.insSF, 0)} SF</b></span></div>`);
  }
  if (T.grossSF < 0.5 && !T.openings && T.gutLF < 0.5 && T.insSF < 0.5) rows.push('<div class="hint" style="margin:4px 0">Nothing yet — trace an elevation (▥), a gutter run (⌐), or insulation (▩).</div>');
  rows.push('<div class="hint" style="margin:4px 0">Trace elevations gross; openings (⊡) deduct from the total, so the bid uses <b>net</b>. Openings still bill a trim &amp; wrap EA — cutting siding around one costs more than the SF it removes. Squares = net ÷ 100. Prices in $ Bid.</div>');
  $('sidBody').innerHTML = rows.join('');
  $('sidMat').value = curSidMat;
  $('sidOpen').value = curSidOpen;
  $('sidWaste').value = S.waste != null ? S.waste : 10;
  $('sidMat').addEventListener('change', e => { curSidMat = e.target.value; if (tool === 'swall') setTool('swall'); });
  $('sidOpen').addEventListener('change', e => { curSidOpen = e.target.value; if (tool === 'sopening') setTool('sopening'); });
  $('sidWaste').addEventListener('change', e => { S.waste = Math.max(0, parseFloat(e.target.value) || 0); e.target.value = S.waste; scheduleSave(); renderSidingPanel(); });
  $('sidGut').value = curSidGut;
  $('sidIns').value = curSidIns;
  $('sidGut').addEventListener('change', e => { curSidGut = e.target.value; if (tool === 'sgutter') setTool('sgutter'); });
  $('sidIns').addEventListener('change', e => { curSidIns = e.target.value; if (tool === 'sinsul') setTool('sinsul'); });
  // the insulation rate inputs only render when there's insulation traced
  if ($('sidInsWaste')) {
    $('sidInsWaste').value = S.insulWaste != null ? S.insulWaste : 5;
    $('sidInsWaste').addEventListener('change', e => { S.insulWaste = Math.max(0, parseFloat(e.target.value) || 0); e.target.value = S.insulWaste; scheduleSave(); renderSidingPanel(); });
  }
  if ($('sidBattCov')) {
    $('sidBattCov').value = S.battCoverage != null ? S.battCoverage : 88;
    $('sidBattCov').addEventListener('change', e => { S.battCoverage = Math.max(1, parseFloat(e.target.value) || 88); e.target.value = S.battCoverage; scheduleSave(); renderSidingPanel(); });
  }
}
$('btnSid').addEventListener('click', () => {
  const p = $('sidPanel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) { closeOtherPanels('sidPanel'); renderSidingPanel(); }
  syncPanelButtons();
});
if ($('sidMatTb')) $('sidMatTb').addEventListener('change', e => { curSidMat = e.target.value; if (tool === 'swall') setTool('swall'); });
if ($('sidOpenTb')) $('sidOpenTb').addEventListener('change', e => { curSidOpen = e.target.value; if (tool === 'sopening') setTool('sopening'); });
if ($('sidGutTb')) $('sidGutTb').addEventListener('change', e => { curSidGut = e.target.value; if (tool === 'sgutter') setTool('sgutter'); });
if ($('sidInsTb')) $('sidInsTb').addEventListener('change', e => { curSidIns = e.target.value; if (tool === 'sinsul') setTool('sinsul'); });

/* ---- Demolition pack ---- */
function demoTotals() {
  const byArea = {}; // dtype -> SF
  const byLine = {}; // ltype -> LF
  const byItem = {}; // itype -> EA
  let areaSF = 0, lineLF = 0, items = 0;
  for (const m of state.markups) {
    if (m.kind === 'dmline') {
      const t = (m.cfg && m.cfg.ltype) || 'curb';
      const lf = dmlineLenFt(m);
      if (lf < 0.01) continue;
      byLine[t] = (byLine[t] || 0) + lf;
      lineLF += lf;
      continue;
    }
    if (m.kind === 'dmitem') {
      const t = (m.cfg && m.cfg.itype) || 'tree';
      const n = m.pts.length;
      byItem[t] = (byItem[t] || 0) + n;
      items += n;
      continue;
    }
    if (m.kind !== 'dmarea') continue;
    const t = (m.cfg && m.cfg.dtype) || 'bldgWood';
    const sf = dmareaSf(m);
    if (sf < 0.01) continue;
    byArea[t] = (byArea[t] || 0) + sf;
    areaSF += sf;
  }
  return { byArea, areaSF, byLine, lineLF, byItem, items };
}
// Debris per type, shared by the bid and the panel so the two can't drift.
//
// The two families convert completely differently and mixing them up is the
// whole pack: a BUILDING is mostly air (footprint x height would be nonsense —
// a 1,000 SF house is not 444 CY), so it uses an empirical CY-per-SF factor with
// bulking already in it. A PAVEMENT is solid, so it's thickness -> in-place CY,
// then swelled: broken concrete/asphalt bulks ~40-60% once ripped, and hauling
// the un-swelled volume under-books trucks.
function demoDebris(T) {
  const D = state.demo || {};
  const swell = 1 + (Number(D.swell) || 0) / 100;
  const perType = {}; // dtype -> { sf, cy, tons }
  let totalCY = 0, totalTons = 0;
  for (const k of DM_AREA_KINDS) {
    const sf = T.byArea[k];
    if (!sf) continue;
    let cy, inPlaceCF;
    if (isDmBuilding(k)) {
      cy = sf * DM_AREA_CYSF[k];       // already loose/bulked
      inPlaceCF = cy * CF_PER_CY;      // tons come off the same volume
    } else {
      const thickIn = Number(D[DM_AREA_THICK_KEY[k]]);
      const t = thickIn > 0 ? thickIn : ({ asphalt: 3, concrete: 6, sidewalk: 4, gravel: 6 })[k];
      inPlaceCF = sf * (t / 12);
      cy = inPlaceCF / CF_PER_CY * swell; // haul the SWELLED volume
    }
    const tons = inPlaceCF * (DM_AREA_DENSITY[k] || 100) / LB_PER_TON;
    perType[k] = { sf, cy, tons };
    totalCY += cy;
    totalTons += tons;
  }
  const cap = Number(D.truckCap) > 0 ? Number(D.truckCap) : 12;
  return { perType, totalCY, totalTons, loads: Math.ceil(totalCY / cap), cap };
}
function demoBidLines() {
  const T = demoTotals();
  const lines = [];
  for (const k of DM_AREA_KINDS) {
    const sf = T.byArea[k];
    if (!sf || sf < 0.5) continue;
    lines.push({ key: `dm_area_${k}`, label: `${DM_AREA_LABEL[k]} — demo`, qty: sf, unit: 'SF', q: 0, defPrice: DM_AREA_PRICE[k] || 1.5 });
  }
  // Linear + item removals are quoted with removal AND haul inside the unit
  // price, so they deliberately do NOT feed the CY pile or the load count —
  // adding them would bill the same hauling twice.
  for (const k of DM_LINE_KINDS) {
    const lf = T.byLine[k];
    if (!lf || lf < 0.5) continue;
    lines.push({ key: `dm_line_${k}`, label: `${DM_LINE_LABEL[k]} (removal + haul)`, qty: lf, unit: 'LF', q: 0, defPrice: DM_LINE_PRICE[k] || 6.5 });
  }
  for (const k of DM_ITEM_KINDS) {
    const ea = T.byItem[k];
    if (!ea) continue;
    lines.push({ key: `dm_item_${k}`, label: `${DM_ITEM_LABEL[k]} (removal + haul)`, qty: ea, unit: 'EA', q: 0, defPrice: DM_ITEM_PRICE[k] || 500 });
  }
  const D = demoDebris(T);
  if (D.loads > 0) lines.push({ key: 'dm_haul', label: `Debris haul (${fmt(D.totalCY, 0)} CY @ ${D.cap} CY/truck)`, qty: D.loads, unit: 'load', q: 0, defPrice: DM_HAUL_PRICE });
  return lines;
}
function renderDemoPanel() {
  const panel = $('demPanel');
  if (!panel || panel.classList.contains('hidden')) return;
  const D = state.demo;
  const T = demoTotals();
  const M = demoDebris(T);
  const rows = [];
  const R = (a, b) => rows.push(`<div class="dirt-row"><span>${a}</span><span class="v">${b}</span></div>`);
  const arOpts = DM_AREA_KINDS.map(k => `<option value="${k}">${DM_AREA_LABEL[k]}</option>`).join('');
  rows.push('<div class="roof-sub">Settings</div>');
  rows.push(`<div class="dirt-set">New areas <select id="dmArea">${arOpts}</select></div>`);
  const lnOpts = DM_LINE_KINDS.map(k => `<option value="${k}">${DM_LINE_LABEL[k]}</option>`).join('');
  rows.push(`<div class="dirt-set">New removals <select id="dmLine">${lnOpts}</select></div>`);
  const itOpts = DM_ITEM_KINDS.map(k => `<option value="${k}">${DM_ITEM_LABEL[k]}</option>`).join('');
  rows.push(`<div class="dirt-set">New items <select id="dmItem">${itOpts}</select></div>`);
  // Only the settings that actually bite the current takeoff are shown: swell
  // and thickness are meaningless with no pavement traced.
  const hasPave = DM_AREA_KINDS.some(k => !isDmBuilding(k) && T.byArea[k]);
  if (hasPave) rows.push('<div class="dirt-set">Swell <input type="number" id="dmSwell" min="0" step="5" style="width:44px"> % · broken pavement bulks up once ripped</div>');
  if (T.byArea.asphalt) rows.push('<div class="dirt-set">Asphalt <input type="number" id="dmTAsp" min="1" step="0.5" style="width:44px"> in thick</div>');
  if (T.byArea.concrete) rows.push('<div class="dirt-set">Concrete <input type="number" id="dmTCon" min="1" step="0.5" style="width:44px"> in thick</div>');
  if (T.byArea.sidewalk) rows.push('<div class="dirt-set">Sidewalk <input type="number" id="dmTSid" min="1" step="0.5" style="width:44px"> in thick</div>');
  if (T.byArea.gravel) rows.push('<div class="dirt-set">Gravel <input type="number" id="dmTGrv" min="1" step="0.5" style="width:44px"> in thick</div>');
  if (T.areaSF > 0.5) rows.push('<div class="dirt-set">Truck <input type="number" id="dmCap" min="1" step="1" style="width:44px"> CY/load</div>');
  if (T.areaSF > 0.5) {
    rows.push('<div class="roof-sub">Areas</div>');
    for (const k of DM_AREA_KINDS) { const sf = T.byArea[k]; if (!sf) continue; R(DM_AREA_LABEL[k], `${fmt(sf, 0)} SF`); }
    rows.push('<div class="roof-sub">Debris</div>');
    for (const k of DM_AREA_KINDS) {
      const d = M.perType[k];
      if (!d) continue;
      R(DM_AREA_LABEL[k], `${fmt(d.cy, 1)} CY · ${fmt(d.tons, 1)} t`);
    }
    rows.push(`<div class="dirt-row"><b>Total debris</b><span class="v"><b>${fmt(M.totalCY, 1)} CY · ${fmt(M.totalTons, 1)} t</b></span></div>`);
    rows.push(`<div class="dirt-row"><b>Truck loads</b><span class="v"><b>${M.loads}</b></span></div>`);
  }
  if (T.lineLF > 0.5) {
    rows.push('<div class="roof-sub">Linear removals</div>');
    for (const k of DM_LINE_KINDS) { const lf = T.byLine[k]; if (!lf) continue; R(DM_LINE_LABEL[k], `${fmt(lf, 0)} LF`); }
    rows.push(`<div class="dirt-row"><b>Total</b><span class="v"><b>${fmt(T.lineLF, 0)} LF</b></span></div>`);
  }
  if (T.items > 0) {
    rows.push('<div class="roof-sub">Items & structures</div>');
    for (const k of DM_ITEM_KINDS) { const ea = T.byItem[k]; if (!ea) continue; R(DM_ITEM_LABEL[k], `${ea} EA`); }
    rows.push(`<div class="dirt-row"><b>Total</b><span class="v"><b>${T.items} EA</b></span></div>`);
  }
  if (T.lineLF > 0.5 || T.items > 0) rows.push('<div class="hint" style="margin:4px 0">Removals and items carry their haul inside the unit price, so they’re not in the CY or the load count above — counting them there would bill the hauling twice.</div>');
  if (T.areaSF < 0.5 && T.lineLF < 0.5 && !T.items) rows.push('<div class="hint" style="margin:4px 0">Nothing yet — trace an area (▣), a removal (⌁), or click items (⊠).</div>');
  rows.push('<div class="hint" style="margin:4px 0"><b>Buildings and pavement convert differently.</b> A building is mostly air, so it uses debris CY per SF of footprint (bulking included) — not footprint × height. Pavement uses its thickness, then swells. Prices in $ Bid.</div>');
  $('demBody').innerHTML = rows.join('');
  $('dmArea').value = curDmArea;
  $('dmArea').addEventListener('change', e => { curDmArea = e.target.value; if (tool === 'dmarea') setTool('dmarea'); });
  $('dmLine').value = curDmLine;
  $('dmItem').value = curDmItem;
  $('dmLine').addEventListener('change', e => { curDmLine = e.target.value; if (tool === 'dmline') setTool('dmline'); });
  $('dmItem').addEventListener('change', e => { curDmItem = e.target.value; if (tool === 'dmitem') setTool('dmitem'); });
  // every rate input is conditional, so bind defensively
  const num = (id, key, def, min) => {
    const el = $(id);
    if (!el) return;
    el.value = D[key] != null ? D[key] : def;
    el.addEventListener('change', ev => {
      D[key] = Math.max(min, parseFloat(ev.target.value) || def);
      ev.target.value = D[key];
      scheduleSave(); renderDemoPanel();
    });
  };
  num('dmSwell', 'swell', 50, 0);
  num('dmTAsp', 'thickAsphalt', 3, 0.5);
  num('dmTCon', 'thickConcrete', 6, 0.5);
  num('dmTSid', 'thickSidewalk', 4, 0.5);
  num('dmTGrv', 'thickGravel', 6, 0.5);
  num('dmCap', 'truckCap', 12, 1);
}
$('btnDem').addEventListener('click', () => {
  const p = $('demPanel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) { closeOtherPanels('demPanel'); renderDemoPanel(); }
  syncPanelButtons();
});
if ($('dmAreaTb')) $('dmAreaTb').addEventListener('change', e => { curDmArea = e.target.value; if (tool === 'dmarea') setTool('dmarea'); });
if ($('dmLineTb')) $('dmLineTb').addEventListener('change', e => { curDmLine = e.target.value; if (tool === 'dmline') setTool('dmline'); });
if ($('dmItemTb')) $('dmItemTb').addEventListener('change', e => { curDmItem = e.target.value; if (tool === 'dmitem') setTool('dmitem'); });

/* ---- Fencing & Guardrail pack ---- */
function fenceTotals() {
  const byLine = {}; // ftype -> { lf, posts, runs }
  let lineLF = 0, posts = 0;
  const byGate = {}; // gtype -> EA
  let gates = 0;
  for (const m of state.markups) {
    if (m.kind === 'fngate') {
      const t = (m.cfg && m.cfg.gtype) || 'walk';
      const n = m.pts.length;
      byGate[t] = (byGate[t] || 0) + n;
      gates += n;
      continue;
    }
    if (m.kind !== 'fnline') continue;
    const t = (m.cfg && m.cfg.ftype) || 'chain6';
    const lf = fnlineLenFt(m);
    if (lf < 0.01) continue;
    // posts are counted PER RUN — see fencePostsFor()
    const p = fencePostsFor(lf, t);
    const g = byLine[t] || { lf: 0, posts: 0, runs: 0 };
    g.lf += lf; g.posts += p; g.runs += 1;
    byLine[t] = g;
    lineLF += lf; posts += p;
  }
  return { byLine, lineLF, posts, byGate, gates };
}
// Post-hole concrete. A cost basis for the panel, NOT bid lines — $/LF for fence
// is an installed price with posts, rails, fabric and concrete already inside it,
// so billing the concrete again would charge for it twice. (Same call as the
// striping pack's paint gallons and demo's haul-in-the-unit-price.)
function fenceConcrete(T) {
  const F = state.fence || {};
  const dia = Number(F.holeDia) > 0 ? Number(F.holeDia) : 10;   // in
  const depth = Number(F.holeDepth) > 0 ? Number(F.holeDepth) : 30; // in
  const bagCF = Number(F.bagCF) > 0 ? Number(F.bagCF) : 0.45;
  const r = dia / 2 / 12; // ft
  const holeCF = Math.PI * r * r * (depth / 12);
  const totalCF = T.posts * holeCF;
  return { holeCF, totalCF, cy: totalCF / CF_PER_CY, bags: Math.ceil(totalCF / bagCF) };
}
function fenceBidLines() {
  const T = fenceTotals();
  const lines = [];
  // Only the run LF and the gates are billed. Posts + concrete are inside the
  // installed $/LF and stay out of the bid on purpose.
  for (const k of FN_LINE_KINDS) {
    const g = T.byLine[k];
    if (!g || g.lf < 0.5) continue;
    lines.push({ key: `fn_line_${k}`, label: `${FN_LINE_LABEL[k]} (installed)`, qty: g.lf, unit: 'LF', q: 0, defPrice: FN_LINE_PRICE[k] || 26 });
  }
  for (const k of FN_GATE_KINDS) {
    const ea = T.byGate[k];
    if (!ea) continue;
    lines.push({ key: `fn_gate_${k}`, label: `${FN_GATE_LABEL[k]} (installed)`, qty: ea, unit: 'EA', q: 0, defPrice: FN_GATE_PRICE[k] || 385 });
  }
  return lines;
}
function renderFencePanel() {
  const panel = $('fncPanel');
  if (!panel || panel.classList.contains('hidden')) return;
  const F = state.fence;
  const T = fenceTotals();
  const rows = [];
  const R = (a, b) => rows.push(`<div class="dirt-row"><span>${a}</span><span class="v">${b}</span></div>`);
  const lnOpts = FN_LINE_KINDS.map(k => `<option value="${k}">${FN_LINE_LABEL[k]}</option>`).join('');
  const gtOpts = FN_GATE_KINDS.map(k => `<option value="${k}">${FN_GATE_LABEL[k]}</option>`).join('');
  rows.push('<div class="roof-sub">Settings</div>');
  rows.push(`<div class="dirt-set">New runs <select id="fnLine">${lnOpts}</select></div>`);
  rows.push(`<div class="dirt-set">New gates <select id="fnGate">${gtOpts}</select></div>`);
  if (T.lineLF > 0.5) {
    rows.push('<div class="roof-sub">Runs</div>');
    for (const k of FN_LINE_KINDS) {
      const g = T.byLine[k];
      if (!g) continue;
      R(`${FN_LINE_LABEL[k]} <span style="opacity:.6">@ ${FN_LINE_SPACING[k]}′</span>`, `${fmt(g.lf, 0)} LF · ${g.posts} posts`);
    }
    rows.push(`<div class="dirt-row"><b>Total</b><span class="v"><b>${fmt(T.lineLF, 0)} LF · ${T.posts} posts</b></span></div>`);
  }
  if (T.gates > 0) {
    rows.push('<div class="roof-sub">Gates & end treatments</div>');
    for (const k of FN_GATE_KINDS) { const ea = T.byGate[k]; if (!ea) continue; R(FN_GATE_LABEL[k], `${ea} EA`); }
    rows.push(`<div class="dirt-row"><b>Total</b><span class="v"><b>${T.gates} EA</b></span></div>`);
  }
  if (T.posts > 0) {
    const C = fenceConcrete(T);
    rows.push('<div class="roof-sub">Post concrete (cost basis)</div>');
    rows.push('<div class="dirt-set">Hole <input type="number" id="fnDia" min="1" step="1" style="width:42px"> in ⌀ × <input type="number" id="fnDepth" min="1" step="1" style="width:42px"> in deep</div>');
    rows.push('<div class="dirt-set">Bag yield <input type="number" id="fnBag" min="0.05" step="0.05" style="width:48px"> CF/bag</div>');
    R('Per hole', `${fmt(C.holeCF, 2)} CF`);
    R(`${T.posts} holes`, `${fmt(C.cy, 2)} CY · ${C.bags} bags`);
    rows.push('<div class="hint" style="margin:4px 0">A cost basis only — not on the bid. The $/LF is installed, so posts and their concrete are already in it; billing them again would charge twice.</div>');
  }
  if (T.lineLF < 0.5 && !T.gates) rows.push('<div class="hint" style="margin:4px 0">Nothing yet — trace a run (⌗) or click gates (⊓).</div>');
  rows.push('<div class="hint" style="margin:4px 0"><b>Posts count per run</b>, not off the total: every run gets one at each end, so two 50′ runs at 10′ = 12 posts, not 11. Spacing comes from the fence type. Prices in $ Bid.</div>');
  $('fncBody').innerHTML = rows.join('');
  $('fnLine').value = curFnLine;
  $('fnGate').value = curFnGate;
  $('fnLine').addEventListener('change', e => { curFnLine = e.target.value; if (tool === 'fnline') setTool('fnline'); });
  $('fnGate').addEventListener('change', e => { curFnGate = e.target.value; if (tool === 'fngate') setTool('fngate'); });
  const num = (id, key, def, min) => {
    const el = $(id);
    if (!el) return;
    el.value = F[key] != null ? F[key] : def;
    el.addEventListener('change', ev => {
      F[key] = Math.max(min, parseFloat(ev.target.value) || def);
      ev.target.value = F[key];
      scheduleSave(); renderFencePanel();
    });
  };
  num('fnDia', 'holeDia', 10, 1);
  num('fnDepth', 'holeDepth', 30, 1);
  num('fnBag', 'bagCF', 0.45, 0.05);
}
$('btnFnc').addEventListener('click', () => {
  const p = $('fncPanel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) { closeOtherPanels('fncPanel'); renderFencePanel(); }
  syncPanelButtons();
});
if ($('fnLineTb')) $('fnLineTb').addEventListener('change', e => { curFnLine = e.target.value; if (tool === 'fnline') setTool('fnline'); });
if ($('fnGateTb')) $('fnGateTb').addEventListener('change', e => { curFnGate = e.target.value; if (tool === 'fngate') setTool('fngate'); });

/* ---- Landscape & Irrigation pack ---- */
function landscapeTotals() {
  const byArea = {}, byPlant = {}, byLine = {}, byHead = {};
  let areaSF = 0, plants = 0, lineLF = 0, heads = 0;
  for (const m of state.markups) {
    if (m.kind === 'lsplant') {
      const t = (m.cfg && m.cfg.ptype) || 'shrub5';
      const n = m.pts.length;
      byPlant[t] = (byPlant[t] || 0) + n; plants += n; continue;
    }
    if (m.kind === 'lshead') {
      const t = (m.cfg && m.cfg.htype) || 'spray';
      const n = m.pts.length;
      byHead[t] = (byHead[t] || 0) + n; heads += n; continue;
    }
    if (m.kind === 'lsline') {
      const t = (m.cfg && m.cfg.ltype) || 'lateral';
      const lf = lslineLenFt(m);
      if (lf < 0.01) continue;
      byLine[t] = (byLine[t] || 0) + lf; lineLF += lf; continue;
    }
    if (m.kind !== 'lsarea') continue;
    const t = (m.cfg && m.cfg.atype) || 'mulch';
    const sf = lsareaSf(m);
    if (sf < 0.01) continue;
    byArea[t] = (byArea[t] || 0) + sf; areaSF += sf;
  }
  return { byArea, areaSF, byPlant, plants, byLine, lineLF, byHead, heads };
}
// SF -> the material's own unit, per type. Depths are per type (a 3" mulch bed
// and a 6" soil-prep bed on the same plan are normal), so this can't collapse
// into one shared number.
//
// Unlike striping/demo/fencing, these ARE the bid quantities rather than a cost
// basis: landscape material is bought by the CY / ton / SY, so quoting mulch per
// SF would be the unnatural choice. Each type yields exactly one line in exactly
// one unit, so there's no double-count to guard against.
function landscapeQty(T) {
  const L = state.landscape || {};
  const num = (v, def) => (Number(v) > 0 ? Number(v) : def);
  const sf = k => T.byArea[k] || 0;
  const rockCF = sf('rock') * (num(L.rockDepth, 3) / 12);
  return {
    mulch: sf('mulch') * (num(L.mulchDepth, 3) / 12) / CF_PER_CY,                 // CY
    bed: sf('bed') * (num(L.bedDepth, 6) / 12) / CF_PER_CY,                       // CY
    rock: rockCF * num(L.rockDensity, 100) / LB_PER_TON,                          // tons
    rockCY: rockCF / CF_PER_CY,
    sod: sf('sod') * (1 + (Number(L.sodWaste) || 0) / 100) / SF_PER_SY,           // SY
    seed: sf('seed'),                                                             // SF (bid unit)
    seedLbs: sf('seed') / 1000 * (Number(L.seedRate) || 0),                       // lbs (buying number)
  };
}
function landscapeBidLines() {
  const T = landscapeTotals();
  const Q = landscapeQty(T);
  const lines = [];
  const push = (k, qty) => {
    if (!(qty > 0.005)) return;
    lines.push({ key: `ls_area_${k}`, label: `${LS_AREA_LABEL[k]} (installed)`, qty, unit: LS_AREA_UNIT[k], q: 0, defPrice: LS_AREA_PRICE[k] });
  };
  push('mulch', Q.mulch); push('sod', Q.sod); push('seed', Q.seed); push('rock', Q.rock); push('bed', Q.bed);
  for (const k of LS_PLANT_KINDS) {
    const ea = T.byPlant[k];
    if (!ea) continue;
    lines.push({ key: `ls_plant_${k}`, label: `${LS_PLANT_LABEL[k]} (installed)`, qty: ea, unit: 'EA', q: 0, defPrice: LS_PLANT_PRICE[k] || 65 });
  }
  for (const k of LS_LINE_KINDS) {
    const lf = T.byLine[k];
    if (!lf || lf < 0.5) continue;
    lines.push({ key: `ls_line_${k}`, label: `${LS_LINE_LABEL[k]} (installed)`, qty: lf, unit: 'LF', q: 0, defPrice: LS_LINE_PRICE[k] || 2.25 });
  }
  for (const k of LS_HEAD_KINDS) {
    const ea = T.byHead[k];
    if (!ea) continue;
    lines.push({ key: `ls_head_${k}`, label: `${LS_HEAD_LABEL[k]} (installed)`, qty: ea, unit: 'EA', q: 0, defPrice: LS_HEAD_PRICE[k] || 28 });
  }
  return lines;
}
function renderLandscapePanel() {
  const panel = $('lscPanel');
  if (!panel || panel.classList.contains('hidden')) return;
  const L = state.landscape;
  const T = landscapeTotals();
  const Q = landscapeQty(T);
  const rows = [];
  const R = (a, b) => rows.push(`<div class="dirt-row"><span>${a}</span><span class="v">${b}</span></div>`);
  const opts = (arr, lab) => arr.map(k => `<option value="${k}">${lab[k]}</option>`).join('');
  rows.push('<div class="roof-sub">Settings</div>');
  rows.push(`<div class="dirt-set">New areas <select id="lsArea">${opts(LS_AREA_KINDS, LS_AREA_LABEL)}</select></div>`);
  rows.push(`<div class="dirt-set">New plants <select id="lsPlant">${opts(LS_PLANT_KINDS, LS_PLANT_LABEL)}</select></div>`);
  rows.push(`<div class="dirt-set">New runs <select id="lsLine">${opts(LS_LINE_KINDS, LS_LINE_LABEL)}</select></div>`);
  rows.push(`<div class="dirt-set">New heads <select id="lsHead">${opts(LS_HEAD_KINDS, LS_HEAD_LABEL)}</select></div>`);
  // rate inputs only for the area types actually traced
  if (T.byArea.mulch) rows.push('<div class="dirt-set">Mulch <input type="number" id="lsMulchD" min="0.5" step="0.5" style="width:44px"> in deep</div>');
  if (T.byArea.rock) rows.push('<div class="dirt-set">Rock <input type="number" id="lsRockD" min="0.5" step="0.5" style="width:44px"> in deep · <input type="number" id="lsRockDen" min="1" step="1" style="width:48px"> lb/ft³</div>');
  if (T.byArea.bed) rows.push('<div class="dirt-set">Bed soil <input type="number" id="lsBedD" min="0.5" step="0.5" style="width:44px"> in deep</div>');
  if (T.byArea.sod) rows.push('<div class="dirt-set">Sod waste <input type="number" id="lsSodW" min="0" step="1" style="width:44px"> %</div>');
  if (T.byArea.seed) rows.push('<div class="dirt-set">Seed <input type="number" id="lsSeedR" min="0" step="0.5" style="width:44px"> lb / 1000 SF</div>');
  if (T.areaSF > 0.5) {
    rows.push('<div class="roof-sub">Areas</div>');
    for (const k of LS_AREA_KINDS) { const sf = T.byArea[k]; if (!sf) continue; R(LS_AREA_LABEL[k], `${fmt(sf, 0)} SF`); }
    rows.push('<div class="roof-sub">Materials</div>');
    if (T.byArea.mulch) R('Mulch', `${fmt(Q.mulch, 1)} CY`);
    if (T.byArea.rock) R('Rock', `${fmt(Q.rockCY, 1)} CY · ${fmt(Q.rock, 1)} t`);
    if (T.byArea.bed) R('Bed soil', `${fmt(Q.bed, 1)} CY`);
    if (T.byArea.sod) R('Sod', `${fmt(Q.sod, 0)} SY`);
    if (T.byArea.seed) R('Seed', `${fmt(Q.seedLbs, 1)} lb`);
  }
  if (T.plants > 0) {
    rows.push('<div class="roof-sub">Plants</div>');
    for (const k of LS_PLANT_KINDS) { const ea = T.byPlant[k]; if (!ea) continue; R(LS_PLANT_LABEL[k], `${ea} EA`); }
    rows.push(`<div class="dirt-row"><b>Total</b><span class="v"><b>${T.plants} EA</b></span></div>`);
  }
  if (T.lineLF > 0.5 || T.heads > 0) {
    rows.push('<div class="roof-sub">Irrigation</div>');
    for (const k of LS_LINE_KINDS) { const lf = T.byLine[k]; if (!lf) continue; R(LS_LINE_LABEL[k], `${fmt(lf, 0)} LF`); }
    for (const k of LS_HEAD_KINDS) { const ea = T.byHead[k]; if (!ea) continue; R(LS_HEAD_LABEL[k], `${ea} EA`); }
  }
  if (T.areaSF < 0.5 && !T.plants && T.lineLF < 0.5 && !T.heads) rows.push('<div class="hint" style="margin:4px 0">Nothing yet — trace an area (▢), count plants (❋), or lay out irrigation (≀ ⊛).</div>');
  rows.push('<div class="hint" style="margin:4px 0">Each area bids in the unit its material is actually bought in — mulch by the CY, rock by the ton, sod by the SY. Seed bids by SF; the lbs above is the buying number. Prices in $ Bid.</div>');
  $('lscBody').innerHTML = rows.join('');
  const sel = (id, cur, set) => { const el = $(id); if (!el) return; el.value = cur(); el.addEventListener('change', e => set(e.target.value)); };
  sel('lsArea', () => curLsArea, v => { curLsArea = v; if (tool === 'lsarea') setTool('lsarea'); });
  sel('lsPlant', () => curLsPlant, v => { curLsPlant = v; if (tool === 'lsplant') setTool('lsplant'); });
  sel('lsLine', () => curLsLine, v => { curLsLine = v; if (tool === 'lsline') setTool('lsline'); });
  sel('lsHead', () => curLsHead, v => { curLsHead = v; if (tool === 'lshead') setTool('lshead'); });
  const num = (id, key, def, min) => {
    const el = $(id);
    if (!el) return;
    el.value = L[key] != null ? L[key] : def;
    el.addEventListener('change', ev => {
      L[key] = Math.max(min, parseFloat(ev.target.value) || def);
      ev.target.value = L[key];
      scheduleSave(); renderLandscapePanel();
    });
  };
  num('lsMulchD', 'mulchDepth', 3, 0.5);
  num('lsRockD', 'rockDepth', 3, 0.5);
  num('lsRockDen', 'rockDensity', 100, 1);
  num('lsBedD', 'bedDepth', 6, 0.5);
  num('lsSodW', 'sodWaste', 5, 0);
  num('lsSeedR', 'seedRate', 5, 0);
}
$('btnLsc').addEventListener('click', () => {
  const p = $('lscPanel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) { closeOtherPanels('lscPanel'); renderLandscapePanel(); }
  syncPanelButtons();
});
if ($('lsAreaTb')) $('lsAreaTb').addEventListener('change', e => { curLsArea = e.target.value; if (tool === 'lsarea') setTool('lsarea'); });
if ($('lsPlantTb')) $('lsPlantTb').addEventListener('change', e => { curLsPlant = e.target.value; if (tool === 'lsplant') setTool('lsplant'); });
if ($('lsLineTb')) $('lsLineTb').addEventListener('change', e => { curLsLine = e.target.value; if (tool === 'lsline') setTool('lsline'); });
if ($('lsHeadTb')) $('lsHeadTb').addEventListener('change', e => { curLsHead = e.target.value; if (tool === 'lshead') setTool('lshead'); });

/* ===================== Live sessions (SSE + REST ops) =====================
 * Host "goes live" on the current project; teammates join and co-edit in real
 * time. Server→client push via EventSource; client→server via REST ops. Every
 * persistent change (markups + scale/roof settings) is diffed against the last
 * synced state and pushed as ops; incoming ops apply without re-emitting.
 * Base-tier feature — not gated on the takeoff layer.
 */

let session = null; // { id, clientId, es, applying, isHost, lastSync, docHash, timer }

async function apiLive(path, opts = {}) {
  const { rest, done } = withTimeout(opts);
  try {
    return await fetch(toolApiBase() + '/live' + path, {
      ...rest,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + toolToken(), ...(rest.headers || {}) },
    });
  } finally { done(); }
}

function sessionDoc() {
  return { scales: state.scales, scaleBars: state.scaleBars, page: state.page, roofPitch: state.roofPitch, roofWaste: state.roofWaste, roofPrices: state.roofPrices, roofOP: state.roofOP, earthwork: state.earthwork, drywall: state.drywall, flooring: state.flooring, framing: state.framing, esc: state.esc, striping: state.striping, siding: state.siding, demo: state.demo, fence: state.fence, landscape: state.landscape };
}
function applySessionDoc(d) {
  if (!d) return;
  if (d.scales) state.scales = d.scales;
  if (d.scaleBars) state.scaleBars = d.scaleBars;
  if (d.roofPitch != null) state.roofPitch = d.roofPitch;
  if (d.roofWaste != null) state.roofWaste = d.roofWaste;
  if (d.roofPrices) state.roofPrices = d.roofPrices;
  if (d.roofOP != null) state.roofOP = d.roofOP;
  if (d.earthwork) state.earthwork = d.earthwork;
  if (d.drywall) state.drywall = d.drywall;
  if (d.flooring) state.flooring = d.flooring;
  if (d.framing) state.framing = d.framing;
  if (d.esc) state.esc = d.esc;
  if (d.striping) state.striping = d.striping;
  if (d.siding) state.siding = d.siding;
  if (d.demo) state.demo = d.demo;
  if (d.fence) state.fence = d.fence;
  if (d.landscape) state.landscape = d.landscape;
  // NOTE: `d.page` is intentionally NOT applied here. The current page is a
  // per-viewer concern — each participant scrolls independently. Following it
  // made every teammate's page jump whenever anyone navigated (bidirectional
  // fighting). The join lands you on the host's page once (see joinSession).
}

function setLiveState(t) { $('liveState').textContent = t || ''; }
// Honest connection status: green when the SSE push is delivering, yellow when
// it isn't but the REST backup poll is keeping us synced, red when neither has
// landed recently. Gives a joiner visible proof they're actually in the session.
function refreshLiveStatus() {
  if (!session) return;
  if (session.connected) { setLiveState('🟢 Live'); return; }
  const fresh = session.syncedAt && (Date.now() - session.syncedAt < 12000);
  setLiveState(fresh ? '🟡 Live · backup sync' : '🔴 Reconnecting…');
}
function updateLiveBar(roster) {
  const label = $('btnLive').querySelector('.btn-label');
  if (!session) {
    $('liveBar').classList.add('hidden');
    $('btnLive').classList.remove('live-on');
    if (label) label.textContent = ' Live Co-Edit';
    return;
  }
  $('liveBar').classList.remove('hidden');
  $('liveName').textContent = state.projectName || 'Live session';
  $('btnLive').classList.add('live-on');
  if (label) label.textContent = ' Co-Editing';
  $('liveEnd').classList.toggle('hidden', !session.isHost);
  if (roster) $('liveRoster').textContent = roster.length ? `${roster.length} here: ${roster.map(r => r.name).join(', ')}` : '';
}

// diff current state vs last-synced and push ops (debounced; hooked into scheduleSave)
function sessionSyncSoon() {
  if (!session || session.applying) return;
  clearTimeout(session.timer);
  session.timer = setTimeout(sessionPush, 250);
}
async function sessionPush() {
  if (!session) return;
  const ops = [];
  const cur = new Map();
  for (const m of state.markups) {
    const j = JSON.stringify(m);
    cur.set(m.id, j);
    if (session.lastSync.get(m.id) !== j) ops.push({ t: 'up', id: m.id, o: m, ts: Date.now() });
  }
  for (const id of session.lastSync.keys()) if (!cur.has(id)) ops.push({ t: 'del', id, ts: Date.now() });
  const docNow = sessionDoc();
  const docHash = JSON.stringify(docNow);
  const doc = docHash !== session.docHash ? docNow : null;
  if (!ops.length && !doc) { session.lastSync = cur; session.docHash = docHash; return; }
  try {
    const res = await apiLive('/' + session.id + '/op', { method: 'POST', body: JSON.stringify({ clientId: session.clientId, ops, doc, docTs: Date.now() }) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    // Commit the baseline ONLY on a confirmed push. If it failed, we keep the old
    // lastSync/docHash so the same diff re-pushes next tick instead of the edit
    // being silently lost (and later clobbered by the backup poll's pull).
    session.lastSync = cur;
    session.docHash = docHash;
  } catch (_) { /* leave baseline; retry on the next edit or poll */ }
}

function applyStream(msg) {
  if (!session) return;
  session.syncedAt = Date.now(); // any message (SSE or backup poll) proves we're syncing
  if (msg.type === 'presence') { updateLiveBar(msg.roster); return; }
  if (msg.type === 'ended') { endSessionLocal(true); return; }
  session.applying = true;
  if (msg.type === 'init') {
    if (Array.isArray(msg.objects)) state.markups = msg.objects;
    applySessionDoc(msg.doc);
    updateLiveBar(msg.roster);
  } else if (msg.type === 'ops') {
    for (const op of msg.ops || []) {
      if (op.t === 'del') state.markups = state.markups.filter(m => m.id !== op.id);
      else if (op.t === 'up' && op.o) {
        const i = state.markups.findIndex(m => m.id === op.o.id);
        if (i >= 0) state.markups[i] = op.o; else state.markups.push(op.o);
      }
    }
    applySessionDoc(msg.doc);
  }
  session.lastSync = new Map(state.markups.map(m => [m.id, JSON.stringify(m)]));
  session.docHash = JSON.stringify(sessionDoc());
  if (selectedId && !selMarkup()) selectedId = null;
  renderMarkupList(); renderRoofPanel(); syncRoofInputs(); syncDirtInputs(); syncDwInputs();
  scheduleSave(); vp.requestDraw();
  session.applying = false;
}

function openStream() {
  session.connected = false;
  const url = toolApiBase() + '/live/' + session.id + '/stream?token=' + encodeURIComponent(toolToken()) + '&client=' + encodeURIComponent(session.clientId);
  let es = null;
  try { es = new EventSource(url); } catch (_) { es = null; }
  session.es = es;
  if (es) {
    es.onopen = () => refreshLiveStatus(); // connection open, but wait for a real message before calling it live
    es.onmessage = e => { session.connected = true; refreshLiveStatus(); try { applyStream(JSON.parse(e.data)); } catch (_) {} };
    es.onerror = () => { session.connected = false; refreshLiveStatus(); }; // EventSource auto-reconnects; the backup poll covers the gap
  }
  // REST backup poll: while the SSE push isn't delivering, pull the room every few
  // seconds so a buffered/blocked stream (common for a cross-origin EventSource
  // through a proxy) can't strand a joiner on a static copy — the likely cause of
  // "I joined but we're not in the same session." Gated on !connected, so it's
  // ~free whenever the stream is healthy.
  if (!session.poll) session.poll = setInterval(livePollTick, 4000);
  refreshLiveStatus();
}

function livePollTick() {
  if (!session) return;
  refreshLiveStatus(); // let the status decay to red if nothing is landing
  if (session.connected || drag || draft) return; // healthy stream, or don't disrupt an active edit
  livePollPull();
}
async function livePollPull() {
  if (!session || session.connected) return;
  await sessionPush(); // flush local edits first so the pulled snapshot already includes them
  if (!session || session.connected) return; // SSE recovered mid-flight
  let t;
  try { const res = await apiLive('/' + session.id, { timeout: 8000 }); if (!res.ok) return; t = await res.json(); }
  catch (_) { return; }
  if (!session || session.connected) return;
  applyStream({ type: 'init', objects: t.objects, doc: t.doc, roster: t.roster });
}

// Base64 of the open plan doc — the CORS-free path when a direct-to-R2 PUT is blocked.
async function docBytesBase64() {
  if (!state.docKey) return null;
  const f = await store.filesGet(state.docKey);
  if (!f || !f.bytes) return null;
  return bytesToBase64(f.bytes);
}

async function goLive() {
  if (session) return;
  if (!state.doc) { setMsg('Open a plan set before going live.'); return; }
  setMsg('Starting the live session…');
  try {
    // Try the fast direct-to-R2 upload; if the bucket has no CORS for a browser
    // PUT it throws, so fall back to handing the PDF up as base64 (the server
    // stores it) — the same fallback shared takeoffs use. Joiners read via base64
    // already, so this makes going live work with or without R2 CORS.
    let pdfUrl = null, pdfBase64 = null;
    try { pdfUrl = await uploadDocToR2(); }
    catch (_) { setMsg('Uploading the plans…'); pdfBase64 = await docBytesBase64(); }
    const res = await apiLive('/', { method: 'POST', body: JSON.stringify({
      tool: 'planroom', name: state.projectName || 'Live session', pdfUrl, pdfBase64, pdfName: state.docName,
      objects: state.markups, doc: sessionDoc(),
    }) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { id } = await res.json();
    session = {
      id: String(id), clientId: randId(), applying: false, isHost: true, timer: null,
      connected: false, syncedAt: Date.now(), poll: null,
      lastSync: new Map(state.markups.map(m => [m.id, JSON.stringify(m)])), docHash: JSON.stringify(sessionDoc()),
    };
    openStream();
    updateLiveBar();
    setMsg('Live co-edit started. Teammates can join from ☁ Company (it shows a LIVE badge).');
  } catch (e) { setMsg('Could not start the session (are you signed in to OpsFloa?): ' + e.message); }
}

async function joinSession(id) {
  if (session) endSessionLocal(false);
  setMsg('Joining the live session…');
  let t;
  try {
    const res = await apiLive('/' + id);
    if (res.status === 404) { setMsg('That session has already ended.'); if (!$('company').classList.contains('hidden')) refreshCompanyList(); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    t = await res.json();
  } catch (e) { setMsg('Could not join: ' + e.message); return; }
  // land the shared doc in a FRESH local project — never overwrite the open one
  await saveProjectNow();
  state.projectId = randId();
  state.projectName = t.name || 'Live session';
  resetDocState();
  state.markups = Array.isArray(t.objects) ? t.objects : [];
  applySessionDoc(t.doc);
  updateProjectBtn(); renderMarkupList(); syncRoofInputs();
  try { localStorage.setItem('planroom-current', state.projectId); } catch (_) {}
  if (t.pdfUrl) {
    try {
      const pr = await apiLive('/' + id + '/pdf');
      if (pr.ok) { const pj = await pr.json(); await openFromBytes(base64ToBytes(pj.b64).buffer, pj.name || t.pdfName || 'plans.pdf', null); if (t.doc && t.doc.page) await setPage(t.doc.page); }
    } catch (_) { setMsg('Joined, but could not load the plans.'); }
  }
  session = {
    id: String(id), clientId: randId(), applying: false, isHost: false, timer: null,
    connected: false, syncedAt: Date.now(), poll: null,
    lastSync: new Map(state.markups.map(m => [m.id, JSON.stringify(m)])), docHash: JSON.stringify(sessionDoc()),
  };
  $('company').classList.add('hidden');
  openStream();
  updateLiveBar();
  scheduleSave(true);
  setMsg(`Joined “${t.name}”. Your markups appear for everyone live.`);
}

function endSessionLocal(remote) {
  if (!session) return;
  const wasHost = session.isHost;
  if (session.es) { try { session.es.close(); } catch (_) {} }
  clearTimeout(session.timer);
  if (session.poll) clearInterval(session.poll);
  session = null;
  updateLiveBar();
  setMsg(remote ? 'The live session ended — your copy is saved in your projects.'
    : wasHost ? 'Live session ended.' : 'You left the session — your copy is saved in your projects.');
}

async function endOrLeave(endForAll) {
  if (!session) return;
  const id = session.id;
  const wasHost = session.isHost;
  let closed = true;
  if (endForAll && wasHost) {
    // Verify the server actually closed it — a swallowed failure here is how a
    // session lingers as joinable after "End for all."
    try { const res = await apiLive('/' + id + '/end', { method: 'POST' }); closed = res.ok; }
    catch (_) { closed = false; }
  }
  endSessionLocal(false);
  if (endForAll && wasHost && !closed) setMsg('You left, but the session may still be open on the server — reopen ☁ Company and hit End on it if it still shows LIVE.');
  if (!$('company').classList.contains('hidden')) refreshCompanyList();
}

// End a live session from the ☁ Company list (host/admin), incl. a lingering one
// whose host closed their tab. Tears down our own session too if we're in it.
async function endSessionFromList(id) {
  if (!window.confirm('Close this live session for everyone? Each person keeps their own copy.')) return;
  companyMsg('Closing the session…');
  try {
    const res = await apiLive('/' + id + '/end', { method: 'POST' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (session && String(session.id) === String(id)) endSessionLocal(false);
    companyMsg('Session closed.');
  } catch (e) { companyMsg('Could not close it (are you the host or an admin?): ' + e.message, true); }
  refreshCompanyList();
}

$('btnLive').addEventListener('click', async () => {
  if (session) {
    if (session.isHost) { if (confirm('End the session for everyone? Each person keeps their own copy.')) endOrLeave(true); }
    else endOrLeave(false);
    return;
  }
  // No active session. If one is ALREADY running for the company, offer to JOIN it
  // rather than spinning up a parallel room — the #1 cause of "we clicked Live but
  // aren't in the same session." (Joining otherwise lives buried in ☁ Company.)
  let running = [];
  try { const r = await apiLive('?tool=planroom', { timeout: 6000 }); if (r.ok) running = await r.json(); } catch (_) {}
  if (Array.isArray(running) && running.length) {
    const s0 = running[0];
    const who = s0.host_name ? `${s0.host_name}'s` : 'A';
    const pick = await askChoice('A live session is already running',
      `${who} live co-edit is going${running.length > 1 ? ` (${running.length} running)` : ''}. Join it so everyone's in the same one, or start a separate session?`,
      [
        { label: '🟢 Join the live session', value: 'join', primary: true },
        { label: 'Start a separate session', value: 'new' },
        { label: 'Cancel', value: null },
      ]);
    if (pick == null) return;
    if (pick === 'join') return joinSession(s0.id);
  }
  return goLive();
});
$('liveLeave').addEventListener('click', () => endOrLeave(false));
$('liveEnd').addEventListener('click', () => { if (confirm('End the session for everyone? Each person keeps their own copy.')) endOrLeave(true); });

/* ============================== Boot ============================== */

// Launched from an OpsFloa estimate (…/planroom/index.html?estimate=<id>).
// Find-or-create: if this browser already holds the linked project, reopen it;
// otherwise start one and pull the estimate's attached plan PDF through the API
// (base64 proxy — no R2 CORS needed). Idempotent: clicking the button again
// reopens the same takeoff. Plan Room projects are per-browser, so on another
// device this starts a fresh (still-linked) takeoff.
async function bootEstimate(id) {
  vp.attach(paint);
  applyTakeoffGate();
  updatePageUI();
  let existing = null;
  try { existing = (await store.projAll()).find(p => p.data && String(p.data.estimateId) === String(id)) || null; } catch (_) {}
  if (existing) { await openProject(existing); setMsg(`Reopened the takeoff linked to estimate #${id}.`); return; }
  await newProject(`Estimate #${id}`);
  state.estimateId = String(id);
  await saveProjectNow();
  if (!toolToken()) { setMsg(`New takeoff for estimate #${id}. Sign in to OpsFloa, then use 📄 Open plans… to load the estimate's PDF.`); return; }
  setMsg('Loading the estimate’s plans…');
  try {
    const r = await apiEstimate('/' + encodeURIComponent(id) + '/plan-pdf', { timeout: 20000 });
    if (r.ok) {
      const j = await r.json();
      const nm = j.name || 'plans.pdf';
      const type = /\.png$/i.test(nm) ? 'image/png' : /\.jpe?g$/i.test(nm) ? 'image/jpeg' : /\.webp$/i.test(nm) ? 'image/webp' : 'application/pdf';
      await openFromBytes(base64ToBytes(j.b64).buffer, nm, type);
      await saveProjectNow();
      setMsg(`Loaded the plans for estimate #${id}. Do the takeoff, then send pricing back from $ Bid.`);
    } else if (r.status === 404) {
      setMsg(`No plans are attached to estimate #${id} yet — attach a PDF on the estimate, or use 📄 Open plans….`);
    } else {
      setMsg(`Couldn't load the estimate's plans (HTTP ${r.status}). Use 📄 Open plans… to load them.`);
    }
  } catch (_) {
    setMsg('Couldn’t reach OpsFloa to load the plans. Use 📄 Open plans… to load them.');
  }
}

async function boot() {
  const estId = new URLSearchParams(location.search).get('estimate');
  if (estId) { await bootEstimate(estId); return; }
  vp.attach(paint);
  applyTakeoffGate();
  updatePageUI();
  let rec = null;
  try {
    const cur = localStorage.getItem('planroom-current');
    if (cur) rec = await store.projGet(cur);
    if (!rec) {
      const all = (await store.projAll()).sort((a, b) => (b.modified || 0) - (a.modified || 0));
      rec = all[0] || null;
    }
  } catch (_) {}
  if (rec) await openProject(rec);
  else await newProject('Project 1');
}

boot();
