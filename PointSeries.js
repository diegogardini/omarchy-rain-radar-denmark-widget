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

// Minutes ahead in words: "20 min", "1 h 10 min"; in Danish ("da") "1 time",
// "1½ time", "2 timer", "1 t 10 min".
function formatLead(minutes, lang) {
  if (minutes < 60) return minutes + " min"
  var h = Math.floor(minutes / 60), m = minutes % 60
  if (lang === "da") {
    if (m === 0) return h === 1 ? "1 time" : h + " timer"
    return m === 30 ? h + "½ time" : h + " t " + m + " min"
  }
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

// The summary as facts, for a page that words them in its own language:
// {now, next}. `now` is null (no radar reading here yet), "dry", or the rain's
// intensity word ("light" .. "extreme"). `next` is null or one of
//   {kind: "heavier", level, minutes}  raining: heavier rain in `minutes`
//   {kind: "dry", minutes, approx}     raining: dry within (~)`minutes`
//   {kind: "ease"}                     raining: may ease off
//   {kind: "rain", level, minutes}     dry: rain in ~`minutes`, up to `level`
//   {kind: "showers"}                  dry: showers nearby
//   {kind: "none", minutes}            dry: no rain expected in the next `minutes`
function summaryParts(series, rainChance, dryBy) {
  var drizzle = 0.1
  var now = currentMm(series)
  if (now === null) return { now: null, next: null }
  var peak = peakAhead(series)
  if (now >= drizzle) {
    var word = intensity(now)
    if (peak && peak.minutes > 0 && intensityRank(peak.mm) > intensityRank(now))
      return { now: word, next: { kind: "heavier", level: intensity(peak.mm), minutes: peak.minutes } }
    var dry = dryFromMinutes(series)
    if (dryBy !== undefined) {
      if (typeof dryBy === "number")
        return { now: word, next: { kind: "dry", minutes: Math.max(10, Math.round(dryBy / 10) * 10), approx: true } }
      return { now: word, next: dry === null ? null : { kind: "ease" } }
    }
    return { now: word, next: dry === null ? null : { kind: "dry", minutes: dry, approx: false } }
  }
  var first = firstAtLeast(series, drizzle)
  if (first) return { now: "dry", next: { kind: "rain", level: intensity(peak.mm), minutes: first.minutes } }
  var covered = coveredMinutes(series)
  if (typeof rainChance === "number" && rainChance >= NO_RAIN_CHANCE) return { now: "dry", next: { kind: "showers" } }
  return { now: "dry", next: covered > 0 ? { kind: "none", minutes: covered } : null }
}

// The summary in words, one line: "Light rain now · dry within ~50 min".
// `lang`: "en" (the default) or "da".
var SUMMARY_WORDS = {
  en: {
    level: { light: "light", moderate: "moderate", heavy: "heavy", "very heavy": "very heavy", extreme: "extreme" },
    noReading: "No radar reading here yet",
    rainNow: function(level) { return level + " rain now" },
    heavier: function(level, lead) { return level + " rain in " + lead },
    ease: "may ease off",
    dryWithin: function(lead, approx) { return "dry within " + (approx ? "~" : "") + lead },
    dryNow: "Dry now",
    lightIn: function(lead) { return "light rain in ~" + lead },
    rainIn: function(lead, level) { return "rain in ~" + lead + ", up to " + level },
    showers: "showers nearby",
    dry: "Dry",
    noneFor: function(lead) { return "no rain expected in the next " + lead }
  },
  da: {
    level: { light: "let", moderate: "moderat", heavy: "kraftig", "very heavy": "meget kraftig", extreme: "ekstrem" },
    noReading: "Ingen radarmåling her endnu",
    rainNow: function(level) { return level + " regn nu" },
    heavier: function(level, lead) { return level + " regn om " + lead },
    ease: "kan aftage",
    dryWithin: function(lead, approx) { return "tørt inden for " + (approx ? "ca. " : "") + lead },
    dryNow: "Tørt nu",
    lightIn: function(lead) { return "let regn om ca. " + lead },
    rainIn: function(lead, level) { return "regn om ca. " + lead + ", op til " + level },
    showers: "byger i nærheden",
    dry: "Tørt",
    noneFor: function(lead) { return "ingen regn ventet de næste " + lead }
  }
}

function summary(series, rainChance, dryBy, lang) {
  var w = SUMMARY_WORDS[lang] || SUMMARY_WORDS.en
  var s = summaryParts(series, rainChance, dryBy)
  var n = s.next
  var lead = function(minutes) { return formatLead(minutes, lang) }
  if (s.now === null) return w.noReading
  if (s.now !== "dry") {
    var text = w.rainNow(w.level[s.now])
    text = text.charAt(0).toUpperCase() + text.slice(1)
    if (!n) return text
    if (n.kind === "heavier") return text + " · " + w.heavier(w.level[n.level], lead(n.minutes))
    if (n.kind === "ease") return text + " · " + w.ease
    return text + " · " + w.dryWithin(lead(n.minutes), n.approx)
  }
  if (!n) return w.dryNow
  if (n.kind === "rain")
    return w.dryNow + " · " + (n.level === "light" ? w.lightIn(lead(n.minutes)) : w.rainIn(lead(n.minutes), w.level[n.level]))
  if (n.kind === "showers") return w.dryNow + " · " + w.showers
  return w.dry + " · " + w.noneFor(lead(n.minutes))
}

if (typeof module !== "undefined") module.exports = {
  HORIZON_MINUTES: HORIZON_MINUTES,
  NO_RAIN_CHANCE: NO_RAIN_CHANCE,
  ageMinutes: ageMinutes,
  coveredMinutes: coveredMinutes,
  summary: summary,
  summaryParts: summaryParts,
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
