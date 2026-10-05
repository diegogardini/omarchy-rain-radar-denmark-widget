// Timing of the radar nowcast: how many steps it runs, and the real
// timestamp of each. Pure functions (no QML), unit-tested.
//
// The nowcast advances the rain by one *scan interval* per step (the motion
// is measured between consecutive scans), so the step count has to come
// from the actual spacing of those scans. The widget uses DMI's full-range
// scans only, one every 10 minutes (see RadarModel.fullRangeOnly); a
// hard-coded step count silently covered only half of the horizon once when
// the cadence was misjudged.
//
// How far it runs is set from the clock: the pin looks `aheadMinutes` past
// the current time, and the newest scan is already `ageMinutes` old (13-35
// min normally), so the nowcast must reach age + ahead after the scan. It
// never runs more than `maxLeadMinutes` after the scan.

var defaultStepMinutes = 10

function parseTime(iso) {
  var t = Date.parse(String(iso || ""))
  return isFinite(t) ? t : null
}

function formatTime(ms) {
  return new Date(ms).toISOString().replace(".000Z", "Z")
}

// Minutes between two scans, clamped to something sane; falls back to the
// nominal cadence when either timestamp is missing or out of order.
function stepMinutes(prevIso, lastIso) {
  var a = parseTime(prevIso), b = parseTime(lastIso)
  if (a === null || b === null || b <= a) return defaultStepMinutes
  var minutes = (b - a) / 60000
  return Math.max(1, Math.min(15, minutes))
}

function nowcastSteps(stepMin, ageMinutes, aheadMinutes, maxLeadMinutes) {
  var need = Math.ceil((Math.max(0, ageMinutes) + aheadMinutes) / stepMin)
  return Math.max(1, Math.min(need, Math.floor(maxLeadMinutes / stepMin)))
}

// Timestamps of nowcast steps 1..steps after the last observed scan.
function nowcastTimes(lastIso, stepMin, steps) {
  var last = parseTime(lastIso)
  var times = []
  for (var k = 1; k <= steps; k++) times.push(last === null ? "" : formatTime(last + k * stepMin * 60000))
  return times
}

// The newest scans that can be used together for one motion estimate: walking
// back from the last item, up to `count` of them, stopping at the first scan
// that is missing (hasFrame(item) false) or whose spacing to its successor is
// not the last interval (a gap would make its displacement span more than one
// step). Returns the items oldest first; a single item means no usable pair.
function trailingRegularRun(items, count, hasFrame, toleranceMinutes) {
  var tol = typeof toleranceMinutes === "number" ? toleranceMinutes : 0.5
  var n = items.length
  if (n === 0 || !hasFrame(items[n - 1])) return []
  var run = [items[n - 1]]
  var step = n >= 2 ? stepMinutes(items[n - 2].datetime, items[n - 1].datetime) : defaultStepMinutes
  for (var j = n - 2; j >= 0 && run.length < count; j--) {
    if (!hasFrame(items[j])) break
    var gap = stepMinutes(items[j].datetime, items[j + 1].datetime)
    if (Math.abs(gap - step) > tol) break
    run.unshift(items[j])
  }
  return run
}

if (typeof module !== "undefined") module.exports = {
  trailingRegularRun: trailingRegularRun,
  defaultStepMinutes: defaultStepMinutes,
  parseTime: parseTime,
  formatTime: formatTime,
  stepMinutes: stepMinutes,
  nowcastSteps: nowcastSteps,
  nowcastTimes: nowcastTimes
}
