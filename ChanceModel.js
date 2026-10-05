// The chance of rain at one location, from the radar nowcast.
//
// One forecast says "rain in 25 min" or "no rain"; the real question is how
// likely. Here 40 copies of the same nowcast are each displaced by a random
// offset that grows with lead time (a standard deviation of about 1 km per
// 3 minutes ahead) and keeps its direction, so every copy is a coherent
// alternative future: the rain arriving a little earlier or later, a little
// further north or south. The chance of a statement is the share of copies
// for which it comes true.
//
// Scored over 176 days of DMI radar in every cell of the Denmark box
// (Denmark-rain-nowcast report, section 5.5 and Appendix C; research backlog #8),
// these chances are honest without calibration and about as good as the
// 24-member pysteps STEPS ensemble: 92 to 100% of its Brier improvement for
// "rain starts within", "dry within" and "rain in the next" 30 min to 2 h
// (96% for "rain starts within an hour", 99% within two hours).
//
// Pure JS, no QML, unit-tested.

var MEMBERS = 40
var KM_PER_MINUTE = 1 / 3          // sigma of the offset: about 1 km for every 3 minutes ahead
var RAIN = 0.1                     // mm/h: what the widget calls rain

// Fixed standard-normal offsets (Box-Muller on a small seeded generator), so
// the chances do not flicker between repaints.
function offsets(n) {
  var s = 20260930
  function rand() {
    s = (s + 0x6D2B79F5) | 0
    var t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  var out = []
  while (out.length < n) {
    var u = Math.max(rand(), 1e-12), v = rand()
    var r = Math.sqrt(-2 * Math.log(u))
    out.push({ x: r * Math.cos(2 * Math.PI * v), y: r * Math.sin(2 * Math.PI * v) })
  }
  return out
}
var OFFSETS = offsets(MEMBERS)

// Kilometres per grid row (the nowcast grid's cells are close to square).
function cellKm(grid) {
  return (grid.bounds.north - grid.bounds.south) * 111.32 / grid.rows
}

// The value of the cell containing (latitude, longitude) moved by
// (dx, dy) cells; 0 outside the grid.
function sampleShifted(grid, latitude, longitude, dx, dy) {
  var b = grid.bounds
  var col = Math.floor((longitude - b.west) / (b.east - b.west) * grid.cols + dx)
  var row = Math.floor((b.north - latitude) / (b.north - b.south) * grid.rows + dy)
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return 0
  var values = grid.rawValues || grid.values
  var v = values[row * grid.cols + col]
  return isFinite(v) ? v : 0
}

// {threshold, steps: [{ms, minutes, chance}], wet: [member][step]} for the
// nowcast [{time, grid}] at one point; null without a nowcast. `scanMs` is the
// newest scan: the copies' offsets grow with the true lead time from it, as
// in the research. `clockMs` (default: the scan) is "now" for the
// statements: each step's `minutes` counts from it, so "within 30 min" means
// 30 minutes from the clock, not from a scan that is 13-35 minutes old.
function compute(nowcast, latitude, longitude, scanMs, threshold, clockMs) {
  if (!nowcast || nowcast.length === 0 || scanMs === null || scanMs === undefined) return null
  var nowMs = typeof clockMs === "number" ? clockMs : scanMs
  var thr = threshold === undefined ? RAIN : threshold
  var steps = [], wet = []
  for (var m = 0; m < MEMBERS; m++) wet.push([])
  for (var k = 0; k < nowcast.length; k++) {
    var g = nowcast[k].grid, ms = Date.parse(nowcast[k].time)
    if (!g || !g.bounds || !isFinite(ms)) continue
    var minutes = Math.round((ms - nowMs) / 60000)
    var sigma = Math.max(0, (ms - scanMs) / 60000) * KM_PER_MINUTE / cellKm(g)
    var n = 0
    for (m = 0; m < MEMBERS; m++) {
      var w = sampleShifted(g, latitude, longitude, OFFSETS[m].x * sigma, OFFSETS[m].y * sigma) >= thr
      wet[m].push(w)
      if (w) n++
    }
    steps.push({ ms: ms, minutes: minutes, chance: n / MEMBERS })
  }
  return steps.length ? { threshold: thr, steps: steps, wet: wet } : null
}

// A step counts as "from now on" if it is at most this many minutes in the
// past (half the 10-minute scan spacing: the step that is valid now).
var NOW_SLACK = 5

// Chance of rain at some step within the next `minutes`.
function rainWithin(c, minutes) {
  if (!c) return null
  var n = 0
  for (var m = 0; m < c.wet.length; m++) {
    for (var k = 0; k < c.steps.length; k++) {
      if (c.steps[k].minutes > -NOW_SLACK && c.steps[k].minutes <= minutes && c.wet[m][k]) { n++; break }
    }
  }
  return n / c.wet.length
}

// Chance that it is dry for good by `minutes`: no rain at any step from then
// to the end of the nowcast (the widget's "dry within").
function dryWithin(c, minutes) {
  if (!c) return null
  var n = 0
  for (var m = 0; m < c.wet.length; m++) {
    var dry = true
    for (var k = 0; k < c.steps.length; k++) {
      if (c.steps[k].minutes >= minutes && c.wet[m][k]) { dry = false; break }
    }
    if (dry) n++
  }
  return n / c.wet.length
}

// Minutes from now (the first step from now on) by which the chance that it
// is dry for good reaches `p`, or null if it never does within the nowcast.
function dryForGoodBy(c, p) {
  if (!c) return null
  for (var k = 0; k < c.steps.length; k++) {
    var m = c.steps[k].minutes
    if (m < 0) continue
    if (dryWithin(c, m) >= p) return m
  }
  return null
}

function pct(x) {
  return Math.round(x * 100) + "%"
}

// The chances for the pin over a stretch of time, counted from now: of rain
// at some point within it when it is dry now ("Rain within"), of the rain
// stopped for good by its end when it is raining now ("Dry for good by").
// Labelled "30 min · 1 h · 1½ h", not the graph's "30m", whose strip gives
// the chance at one moment.
function horizonLabel(h) {
  return h < 60 ? h + " min" : (h % 60 ? Math.floor(h / 60) + "½ h" : h / 60 + " h")
}

// As parts for a small table: {title, items: [{label, percent}]}.
function parts(c, nowMm) {
  if (!c) return null
  var last = c.steps[c.steps.length - 1].minutes
  var hs = [30, 60, 90].filter(function(h) { return h <= last })
  if (hs.length === 0) return null
  var raining = nowMm !== null && nowMm >= RAIN
  return {
    title: raining ? "Dry for good by" : "Rain within",
    items: hs.map(function(h) { return { label: horizonLabel(h), percent: pct(raining ? dryWithin(c, h) : rainWithin(c, h)) } })
  }
}

function describe(c, nowMm) {
  if (!c) return ""
  var horizons = [30, 60, 90]
  var last = c.steps[c.steps.length - 1].minutes
  var hs = horizons.filter(function(h) { return h <= last })
  if (hs.length === 0) return ""
  var raining = nowMm !== null && nowMm >= RAIN
  return (raining ? "Dry for good by " : "Rain within ") + hs.map(function(h) {
    return horizonLabel(h) + " " + pct(raining ? dryWithin(c, h) : rainWithin(c, h))
  }).join(" · ")
}

if (typeof module !== "undefined") module.exports = {
  MEMBERS: MEMBERS,
  KM_PER_MINUTE: KM_PER_MINUTE,
  RAIN: RAIN,
  offsets: offsets,
  cellKm: cellKm,
  sampleShifted: sampleShifted,
  compute: compute,
  rainWithin: rainWithin,
  dryWithin: dryWithin,
  dryForGoodBy: dryForGoodBy,
  describe: describe,
  parts: parts
}
