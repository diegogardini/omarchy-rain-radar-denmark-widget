// The rain rate at one location over time: samples the observed radar grids
// and the nowcast grids at a latitude/longitude and lines the results up on
// a real time axis. Pure functions (no QML), unit-tested.
//
// Grids are {cols, rows, bounds, values}, row 0 = north, cells linear in
// longitude and latitude (see helpers/dmi-radar-convert.py).

// The value of the cell containing the point (nearest-cell, so a reading is
// exactly what the map shows there); null if the point lies outside the
// grid. `raw` reads a grid's `rawValues` where it has them (the nowcast's
// are its `values`, nothing is faded).
function sampleGrid(grid, latitude, longitude, raw) {
  if (!grid || !grid.bounds || !grid.cols || !grid.rows) return null
  var b = grid.bounds
  if (latitude < b.south || latitude > b.north || longitude < b.west || longitude > b.east) return null
  var col = Math.min(grid.cols - 1, Math.floor((longitude - b.west) / (b.east - b.west) * grid.cols))
  var row = Math.min(grid.rows - 1, Math.floor((b.north - latitude) / (b.north - b.south) * grid.rows))
  var values = (raw && grid.rawValues) ? grid.rawValues : grid.values
  var value = values[row * grid.cols + col]
  return isFinite(value) ? value : null
}

// How far ahead the pin's statements look, from the clock (not from the
// scan): "rain in ~25 min", "none expected in the next 90 min", the chances.
// The newest full-range scan is normally 13 to about 35 minutes old (DMI
// publishes each 12-13 min after its time stamp, every 10 min, and the widget
// polls every 10 min), and the nowcast is computed far enough to cover this.
var HORIZON_MINUTES = 90

function timeMs(iso) {
  var t = Date.parse(String(iso || ""))
  return isFinite(t) ? t : null
}

// Series for one location: {points: [{ms, mm, kind}], nowMs, scanMs, endMs},
// oldest first. `nowMs` is the clock (`clockMs`, or the newest scan when
// omitted), `scanMs` the newest scan and `endMs` the nowcast's last step
// (it may lie past the points kept).
//   observed  [{time, grid}]   past scans — kind "observed"
//   nowcast   [{time, grid}]   extrapolated steps — kind "nowcast", up to
//                              HORIZON_MINUTES after the clock
// Steps with no timestamp or no reading at the point are left out.
function build(observed, nowcast, latitude, longitude, clockMs) {
  var points = []
  var i, ms, mm
  var scanMs = null
  for (i = 0; i < (observed || []).length; i++) {
    ms = timeMs(observed[i].time)
    mm = sampleGrid(observed[i].grid, latitude, longitude, false)
    if (ms === null || mm === null) continue
    points.push({ ms: ms, mm: mm, kind: "observed" })
    if (scanMs === null || ms > scanMs) scanMs = ms
  }
  var nowMs = typeof clockMs === "number" && scanMs !== null ? Math.max(clockMs, scanMs) : scanMs
  var endMs = null
  for (i = 0; i < (nowcast || []).length; i++) {
    ms = timeMs(nowcast[i].time)
    mm = sampleGrid(nowcast[i].grid, latitude, longitude, true)
    if (ms === null || mm === null) continue
    if (endMs === null || ms > endMs) endMs = ms
    if (nowMs !== null && ms > nowMs + HORIZON_MINUTES * 60000) continue
    points.push({ ms: ms, mm: mm, kind: "nowcast" })
  }
  points.sort(function(a, b) { return a.ms - b.ms })
  return { points: points, nowMs: nowMs, scanMs: scanMs, endMs: endMs }
}

// Minutes the newest scan is old at the clock, or null without one.
function ageMinutes(series) {
  return series.scanMs === null || series.nowMs === null ? null : Math.round((series.nowMs - series.scanMs) / 60000)
}

// Minutes after now that the nowcast covers, at most HORIZON_MINUTES; 0
// without one.
function coveredMinutes(series) {
  var last = series.endMs
  if (last === undefined) {          // a hand-built series: its last nowcast point
    last = null
    for (var i = 0; i < series.points.length; i++)
      if (series.points[i].kind === "nowcast") last = series.points[i].ms
  }
  if (last === null || series.nowMs === null) return 0
  return Math.min(HORIZON_MINUTES, Math.max(0, Math.round((last - series.nowMs) / 60000)))
}

// Rain rate right now (at the clock): the newest scan if it is from now,
// otherwise the nowcast at this moment, interpolated between its steps. The
// newest scan is 13-35 minutes old, and moving the rain along already beats
// holding that scan at +30 min (research report, section 5.2 and D.5). Null
// without a reading, or when the nowcast does not reach the clock.
function currentMm(series) {
  if (series.nowMs === null) return null
  var before = null, after = null
  for (var i = 0; i < series.points.length; i++) {
    var p = series.points[i]
    if (p.ms <= series.nowMs) before = p
    else if (after === null) after = p
  }
  if (before === null) return null
  if (before.ms === series.nowMs || after === null) return before.ms === series.nowMs ? before.mm : null
  var t = (series.nowMs - before.ms) / (after.ms - before.ms)
  return before.mm + (after.mm - before.mm) * t
}

// The heaviest reading still to come from the radar nowcast, and how many
// minutes from now it is expected; null when there is no nowcast ahead.
function peakAhead(series) {
  var best = null
  for (var i = 0; i < series.points.length; i++) {
    var p = series.points[i]
    if (p.kind !== "nowcast" || p.ms <= series.nowMs) continue
    if (best === null || p.mm > best.mm) best = { mm: p.mm, minutes: Math.round((p.ms - series.nowMs) / 60000) }
  }
  return best
}

// The first upcoming reading at or above `threshold` mm/h ("rain starts in
// 25 min"), or null if none. Meant for a dry-now case.
function firstAtLeast(series, threshold) {
  for (var i = 0; i < series.points.length; i++) {
    var p = series.points[i]
    if (p.kind === "nowcast" && p.ms > series.nowMs && p.mm >= threshold) return { mm: p.mm, minutes: Math.round((p.ms - series.nowMs) / 60000) }
  }
  return null
}

// The point nearest in time to `ms` (for reading a value at the playback
// cursor), or null for an empty series.
function nearest(series, ms) {
  var best = null, bestGap = Infinity
  for (var i = 0; i < series.points.length; i++) {
    var gap = Math.abs(series.points[i].ms - ms)
    if (gap < bestGap) { bestGap = gap; best = series.points[i] }
  }
  return best
}

function formatMm(mm) {
  return (mm < 10 ? mm.toFixed(1) : mm.toFixed(0)) + " mm/h"
}

function formatLead(minutes) {
  if (minutes < 60) return minutes + " min"
  var h = Math.floor(minutes / 60), m = minutes % 60
  return m === 0 ? h + " h" : h + " h " + m + " min"
}

// Minutes from now after which every remaining nowcast reading is below
// drizzle (the rain has stopped for good within the horizon), or null when
// it is still raining at the horizon's end or there is no nowcast.
function dryFromMinutes(series) {
  var lastWet = null, sawNowcast = false, lastPoint = null
  for (var i = 0; i < series.points.length; i++) {
    var p = series.points[i]
    if (p.kind !== "nowcast" || p.ms <= series.nowMs) continue
    sawNowcast = true
    lastPoint = p
    if (p.mm >= 0.1) lastWet = p
  }
  if (!sawNowcast || (lastWet && lastWet === lastPoint)) return null
  var firstDry = null
  for (i = 0; i < series.points.length; i++) {
    p = series.points[i]
    if (p.kind === "nowcast" && p.ms > (lastWet ? lastWet.ms : series.nowMs)) { firstDry = p; break }
  }
  return firstDry ? Math.round((firstDry.ms - series.nowMs) / 60000) : null
}

// Rain in words, for a person rather than in mm/h: the legend's scale (and
// the edge hatching's levels). "Very heavy" starts at 30 mm/h, DMI's
// cloudburst ("skybrud", 15 mm in 30 minutes). Null below 0.1 mm/h (dry).
var INTENSITY = [
  { below: 4, word: "light" },
  { below: 15, word: "moderate" },
  { below: 30, word: "heavy" },
  { below: 60, word: "very heavy" },
  { below: Infinity, word: "extreme" }
]
function intensityRank(mm) {
  if (mm === null || mm < 0.1) return -1
  for (var i = 0; i < INTENSITY.length; i++) if (mm < INTENSITY[i].below) return i
  return INTENSITY.length - 1
}
function intensity(mm) {
  var r = intensityRank(mm)
  return r < 0 ? null : INTENSITY[r].word
}

// One line about the pin: what is falling now and what the nowcast expects
// over the next HORIZON_MINUTES (or as far as the nowcast reaches), in words.
// Rain below 0.1 mm/h counts as dry.
// `rainChance` (optional, 0..1): the chance of rain at the place within the
// time the nowcast covers (ChanceModel.rainWithin). The best guess can pass a
// shower a few km by, so "no rain" is said only when that chance is below
// NO_RAIN_CHANCE too; otherwise "showers nearby", and the chances give the odds.
// `dryBy` (optional): when raining, the minutes from now by which the chance
// of more rain falls below NO_RAIN_CHANCE (ChanceModel.dryForGoodBy with
// 1 - NO_RAIN_CHANCE), or null if it never does. The same rule the other way:
// "dry within" gives that time, to the nearest 10 min as the table counts it, not the best guess's
// own; if it never comes, "may ease off" when the best guess dries.
var NO_RAIN_CHANCE = 0.1

function summary(series, rainChance, dryBy) {
  var drizzle = 0.1
  var now = currentMm(series)
  if (now === null) return "No radar reading here yet"
  var peak = peakAhead(series)
  if (now >= drizzle) {
    var word = intensity(now)
    var text = word.charAt(0).toUpperCase() + word.slice(1) + " rain now"
    if (peak && peak.minutes > 0 && intensityRank(peak.mm) > intensityRank(now))
      return text + " · " + intensity(peak.mm) + " rain in " + formatLead(peak.minutes)
    var dry = dryFromMinutes(series)
    if (dryBy !== undefined) {
      if (typeof dryBy === "number") return text + " · dry within ~" + formatLead(Math.max(10, Math.round(dryBy / 10) * 10))
      return dry === null ? text : text + " · may ease off"
    }
    return dry === null ? text : text + " · dry within " + formatLead(dry)
  }
  var first = firstAtLeast(series, drizzle)
  if (first) {
    var top = intensity(peak.mm)
    return top === "light" ? "Dry now · light rain in ~" + formatLead(first.minutes)
      : "Dry now · rain in ~" + formatLead(first.minutes) + ", up to " + top
  }
  var covered = coveredMinutes(series)
  if (typeof rainChance === "number" && rainChance >= NO_RAIN_CHANCE) return "Dry now · showers nearby"
  return covered > 0 ? "Dry · no rain expected in the next " + formatLead(covered) : "Dry now"
}

if (typeof module !== "undefined") module.exports = {
  HORIZON_MINUTES: HORIZON_MINUTES,
  NO_RAIN_CHANCE: NO_RAIN_CHANCE,
  ageMinutes: ageMinutes,
  coveredMinutes: coveredMinutes,
  summary: summary,
  intensity: intensity,
  formatMm: formatMm,
  formatLead: formatLead,
  sampleGrid: sampleGrid,
  build: build,
  currentMm: currentMm,
  peakAhead: peakAhead,
  firstAtLeast: firstAtLeast,
  nearest: nearest
}
