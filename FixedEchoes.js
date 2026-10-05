// Fixed radar echoes: places where DMI's radar shows rain far more often
// than rain allows (structures, wind turbines, the beam catching the ground).
// One cell in central Copenhagen is wet (0.5 mm/h) in 2.9% of the scans in
// which almost the whole map is dry; offshore wind farms in the southern
// Baltic do the same. Read raw, a pin in Copenhagen sees rain in about 1 in
// 20 dry scans (0.1 mm/h), and the radar there reads 9 times the rain of the
// gauge at Kastrup airport.
//
// Setting those cells to dry would also erase real rain passing over them (at
// Copenhagen a 5 x 3 cell patch, about 16 x 10 km, over the city centre). So
// every masked cell is filled, in every scan, from the cells one and two
// cells outside its patch, weighted by inverse squared distance: dry
// surroundings remove the echo, wet ones carry a shower through. Tested on
// 185 days of radar (Denmark-rain-nowcast report, Appendix A.3; research
// backlog #27): moved onto 38 clean gauges, the filled cell catches 89% of
// the radar's rainy scans with the amount kept; at Copenhagen the dry-scan
// wet share falls from 4.8% to 0.75% (a clean cell at Kastrup: 0.54%).
// Inside a patch, a shower's edges and peaks are an estimate.

// The mask (results/fixed-echo-mask.npy in the research repo: cells wet in
// more than 1% of almost-dry scans, plus the ring around each), as [row, col]
// on the 224 x 160 nowcast grid over BOUNDS, row 0 north.
var COLS = 224
var ROWS = 160
var BOUNDS = { west: 5.0, south: 53.9, east: 16.5, north: 58.5 }
var CELLS = [
  [97,146],[97,147],[97,148],[98,146],[98,147],[98,148],[99,146],[99,147],[99,148],[100,146],[100,147],[100,148],
  [100,154],[100,155],[100,156],[101,146],[101,147],[101,148],[101,154],[101,155],[101,156],[102,154],[102,155],
  [102,156],[103,154],[103,155],[103,156],[120,157],[120,158],[120,159],[120,160],[120,161],[121,157],[121,158],
  [121,159],[121,160],[121,161],[122,157],[122,158],[122,159],[122,160],[122,161],[123,157],[123,158],[123,159],
  [123,160],[125,171],[125,172],[125,173],[125,174],[125,175],[125,176],[125,177],[125,178],[126,170],[126,171],
  [126,172],[126,173],[126,174],[126,175],[126,176],[126,177],[126,178],[127,170],[127,171],[127,172],[127,173],
  [127,174],[127,175],[127,176],[127,177],[127,178],[127,179],[128,170],[128,171],[128,172],[128,173],[128,174],
  [128,175],[128,176],[128,177],[128,178],[128,179],[129,171],[129,172],[129,173],[129,174],[129,175],[129,176],
  [129,177],[129,178],[129,179],[130,175],[130,176],[130,177],[130,178],[130,179],[131,176],[131,177],[131,178]
]
var REACH = 2   // source cells: up to this many cells outside a patch

// The mask split into patches (cells touching, diagonals included).
function patches() {
  var masked = {}
  for (var i = 0; i < CELLS.length; i++) masked[CELLS[i][0] * COLS + CELLS[i][1]] = true
  var seen = {}, out = []
  for (var j = 0; j < CELLS.length; j++) {
    var start = CELLS[j][0] * COLS + CELLS[j][1]
    if (seen[start]) continue
    var patch = [], stack = [start]
    seen[start] = true
    while (stack.length) {
      var idx = stack.pop(), r = Math.floor(idx / COLS), c = idx % COLS
      patch.push(idx)
      for (var dr = -1; dr <= 1; dr++)
        for (var dc = -1; dc <= 1; dc++) {
          var n = (r + dr) * COLS + (c + dc)
          if (masked[n] && !seen[n]) { seen[n] = true; stack.push(n) }
        }
    }
    out.push(patch)
  }
  return out
}

// For every masked cell, its source cells (the patch's ring, REACH cells
// wide) and their weights, 1 / squared distance.
function buildPlan() {
  var plan = []
  var ps = patches()
  for (var p = 0; p < ps.length; p++) {
    var inPatch = {}
    for (var i = 0; i < ps[p].length; i++) inPatch[ps[p][i]] = true
    var ring = [], inRing = {}
    for (var k = 0; k < ps[p].length; k++) {
      var r = Math.floor(ps[p][k] / COLS), c = ps[p][k] % COLS
      for (var dr = -REACH; dr <= REACH; dr++)
        for (var dc = -REACH; dc <= REACH; dc++) {
          var rr = r + dr, cc = c + dc, n = rr * COLS + cc
          if (rr < 0 || cc < 0 || rr >= ROWS || cc >= COLS || inPatch[n] || inRing[n]) continue
          inRing[n] = true
          ring.push(n)
        }
    }
    for (var m = 0; m < ps[p].length; m++) {
      var mr = Math.floor(ps[p][m] / COLS), mc = ps[p][m] % COLS
      var sources = [], weights = []
      for (var s = 0; s < ring.length; s++) {
        var sr = Math.floor(ring[s] / COLS), sc = ring[s] % COLS
        sources.push(ring[s])
        weights.push(1 / ((sr - mr) * (sr - mr) + (sc - mc) * (sc - mc)))
      }
      plan.push({ cell: ps[p][m], sources: sources, weights: weights })
    }
  }
  return plan
}

var _plan = null
function plan() {
  if (!_plan) _plan = buildPlan()
  return _plan
}

// Whether `grid` is the nowcast grid the mask was made for.
function applies(grid) {
  if (!grid || !grid.values || grid.cols !== COLS || grid.rows !== ROWS || !grid.bounds) return false
  var b = grid.bounds
  return Math.abs(b.west - BOUNDS.west) < 1e-6 && Math.abs(b.east - BOUNDS.east) < 1e-6 &&
    Math.abs(b.south - BOUNDS.south) < 1e-6 && Math.abs(b.north - BOUNDS.north) < 1e-6
}

// Fills the masked cells of an observed grid in place and returns it. Every
// value is computed from the unfilled grid; cells without a finite source
// value are skipped. Any other grid is returned unchanged.
function fill(grid) {
  if (!applies(grid) || grid.fixedEchoesFilled) return grid
  var values = grid.values, steps = plan(), filled = []
  for (var i = 0; i < steps.length; i++) {
    var sum = 0, weight = 0
    for (var k = 0; k < steps[i].sources.length; k++) {
      var v = values[steps[i].sources[k]]
      if (!isFinite(v)) continue
      sum += v * steps[i].weights[k]
      weight += steps[i].weights[k]
    }
    filled.push(weight > 0 ? sum / weight : values[steps[i].cell])
  }
  for (var j = 0; j < steps.length; j++) values[steps[j].cell] = filled[j]
  grid.fixedEchoesFilled = true
  return grid
}

if (typeof module !== "undefined") module.exports = {
  COLS: COLS,
  ROWS: ROWS,
  BOUNDS: BOUNDS,
  CELLS: CELLS,
  patches: patches,
  plan: plan,
  applies: applies,
  fill: fill
}
