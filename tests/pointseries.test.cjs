const { test } = require('node:test')
const assert = require('node:assert/strict')
const PointSeries = require('../PointSeries.js')
const MapModel = require('../MapModel.js')
const Timeline = require('../Timeline.js')
const Interpolation = require('../Interpolation.js')

// 4 x 2 grid over a 4 deg x 2 deg box: each cell is 1 deg x 1 deg.
//   row 0 (north, lat 57-58): 1 2 3 4     row 1 (south, lat 56-57): 5 6 7 8
function tiny(values, rawValues) {
  return { cols: 4, rows: 2, bounds: { west: 8, east: 12, south: 56, north: 58 }, values: values || [1, 2, 3, 4, 5, 6, 7, 8], rawValues }
}

test('sampleGrid picks the cell containing the point, row 0 being north', () => {
  const g = tiny()
  assert.equal(PointSeries.sampleGrid(g, 57.5, 8.5), 1)
  assert.equal(PointSeries.sampleGrid(g, 57.5, 11.5), 4)
  assert.equal(PointSeries.sampleGrid(g, 56.5, 8.5), 5)
  assert.equal(PointSeries.sampleGrid(g, 56.5, 11.5), 8)
  assert.equal(PointSeries.sampleGrid(g, 57.2, 9.9), 2)
})

test('sampleGrid handles the grid edges and rejects points outside', () => {
  const g = tiny()
  assert.equal(PointSeries.sampleGrid(g, 58, 12), 4) // top-right corner belongs to the last column, first row
  assert.equal(PointSeries.sampleGrid(g, 56, 8), 5)
  assert.equal(PointSeries.sampleGrid(g, 58.01, 10), null)
  assert.equal(PointSeries.sampleGrid(g, 57, 7.99), null)
  assert.equal(PointSeries.sampleGrid(null, 57, 10), null)
  assert.equal(PointSeries.sampleGrid({}, 57, 10), null)
})

test('sampleGrid reads the unfaded field only when asked and available', () => {
  const g = tiny([1, 1, 1, 1, 1, 1, 1, 1], [9, 9, 9, 9, 9, 9, 9, 9])
  assert.equal(PointSeries.sampleGrid(g, 57.5, 8.5, false), 1)
  assert.equal(PointSeries.sampleGrid(g, 57.5, 8.5, true), 9)
  assert.equal(PointSeries.sampleGrid(tiny(), 57.5, 8.5, true), 1) // observed grids have no rawValues
})

test('sampleGrid matches where the map draws a cell (same layout as RadarMap.drawGrid)', () => {
  // A cell's centre, converted through the map projection and back, samples that same cell.
  const cols = 224, rows = 160, b = MapModel.bounds
  const values = new Float32Array(cols * rows)
  for (let i = 0; i < values.length; i++) values[i] = i
  const grid = { cols, rows, bounds: b, values }
  for (const [row, col] of [[0, 0], [10, 100], [80, 112], [159, 223], [37, 5]]) {
    const lat = b.north - (row + 0.5) * (b.north - b.south) / rows
    const lon = b.west + (col + 0.5) * (b.east - b.west) / cols
    assert.equal(PointSeries.sampleGrid(grid, lat, lon), row * cols + col)
  }
})

function series() {
  const observed = [
    { time: '2026-09-20T10:00:00Z', grid: tiny([0, 0, 0, 0, 1, 1, 1, 1]) },
    { time: '2026-09-20T10:05:00Z', grid: tiny([0, 0, 0, 0, 2, 2, 2, 2]) }
  ]
  const nowcast = [
    { time: '2026-09-20T10:10:00Z', grid: tiny([0, 0, 0, 0, 1, 1, 1, 1], [0, 0, 0, 0, 4, 4, 4, 4]) },
    { time: '2026-09-20T10:15:00Z', grid: tiny([0, 0, 0, 0, 1, 1, 1, 1], [0, 0, 0, 0, 6, 6, 6, 6]) },
    { time: '2026-09-20T10:20:00Z', grid: tiny([0, 0, 0, 0, 1, 1, 1, 1], [0, 0, 0, 0, 3, 3, 3, 3]) }
  ]
  return PointSeries.build(observed, nowcast, 56.5, 10)
}

test('build lines observed and nowcast up on a real time axis, in order', () => {
  const s = series()
  assert.deepEqual(s.points.map((p) => p.kind), ['observed', 'observed', 'nowcast', 'nowcast', 'nowcast'])
  assert.deepEqual(s.points.map((p) => p.mm), [1, 2, 4, 6, 3]) // nowcast uses the unfaded field
  assert.equal(s.nowMs, Date.parse('2026-09-20T10:05:00Z'))
  for (let i = 1; i < s.points.length; i++) assert.ok(s.points[i].ms > s.points[i - 1].ms)
})

test('current, peak-ahead and first-rain readings', () => {
  const s = series()
  assert.equal(PointSeries.currentMm(s), 2)
  assert.deepEqual(PointSeries.peakAhead(s), { mm: 6, minutes: 10 })
  assert.deepEqual(PointSeries.firstAtLeast(s, 5), { mm: 6, minutes: 10 })
  assert.deepEqual(PointSeries.firstAtLeast(s, 0.1), { mm: 4, minutes: 5 })
  assert.equal(PointSeries.firstAtLeast(s, 50), null)
})

test('nearest finds the point closest in time', () => {
  const s = series()
  assert.equal(PointSeries.nearest(s, Date.parse('2026-09-20T10:11:00Z')).mm, 4)
  assert.equal(PointSeries.nearest(s, Date.parse('2026-09-20T09:00:00Z')).mm, 1)
  assert.equal(PointSeries.nearest({ points: [] }, 0), null)
})

test('a pin outside the grids gives an empty series, not zeros', () => {
  const s = PointSeries.build([{ time: '2026-09-20T10:00:00Z', grid: tiny() }], [], 40, 10)
  assert.deepEqual(s.points, [])
  assert.equal(s.nowMs, null)
  assert.equal(PointSeries.currentMm(s), null)
  assert.equal(PointSeries.peakAhead(s), null)
})

test('steps without a valid timestamp are skipped', () => {
  const s = PointSeries.build([{ time: '', grid: tiny() }, { time: 'x', grid: tiny() }], [{ time: '', grid: tiny() }], 56.5, 10)
  assert.deepEqual(s.points, [])
})

test('end to end: a shower drifting toward the pin appears in the pin series at the right time', () => {
  // A 10 mm/h shower 30 cells west of the pin moving 1 cell (~3.2 km) east per 5 min.
  const cols = 224, rows = 160, b = MapModel.bounds
  const grid = (cx) => {
    const v = new Float32Array(cols * rows)
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) v[r * cols + c] = 10 * Math.exp(-(((c - cx) / 3) ** 2 + ((r - 80) / 3) ** 2))
    return { cols, rows, bounds: b, values: v }
  }
  const a = grid(70), bgrid = grid(72) // 2 cells per 5 min
  const t0 = '2026-09-20T10:00:00Z', t1 = '2026-09-20T10:05:00Z'
  const step = Timeline.stepMinutes(t0, t1)
  const steps = 24  // 2 h at 5-minute steps
  const seq = Interpolation.extrapolateSequence(a, bgrid, steps, 8, 6, 0.3)
  const times = Timeline.nowcastTimes(t1, step, steps)
  const nowcast = seq.map((grid, i) => ({ time: times[i], grid }))
  // pin at the centre of column 72 + 2*10 = 92 (arrives after 10 steps = 50 min), row 80
  const lat = b.north - (80 + 0.5) * (b.north - b.south) / rows
  const lon = b.west + (92 + 0.5) * (b.east - b.west) / cols
  const s = PointSeries.build([{ time: t0, grid: a }, { time: t1, grid: bgrid }], nowcast, lat, lon)
  assert.ok(PointSeries.currentMm(s) < 0.01)
  const peak = PointSeries.peakAhead(s)
  assert.ok(peak.mm > 8, 'peak ' + peak.mm)
  assert.ok(Math.abs(peak.minutes - 50) <= 5, 'minutes ' + peak.minutes)
  const first = PointSeries.firstAtLeast(s, 1)
  assert.ok(first.minutes < peak.minutes && first.minutes > 30)
})

function seriesOf(now, ahead) {
  // now: mm/h at the last scan; ahead: mm/h at +5, +10, ... minutes
  const t0 = Date.parse('2026-09-20T10:00:00Z')
  const points = [{ ms: t0 - 300000, mm: now, kind: 'observed' }, { ms: t0, mm: now, kind: 'observed' }]
  ahead.forEach((mm, i) => points.push({ ms: t0 + (i + 1) * 300000, mm, kind: 'nowcast' }))
  return { points, nowMs: t0 }
}

test('summary: dry now and staying dry', () => {
  // the nowcast here reaches 15 min ahead; the text claims no further
  assert.equal(PointSeries.summary(seriesOf(0, [0, 0.02, 0])), 'Dry · no rain expected in the next 15 min')
})

test('summary: dry now, rain arriving', () => {
  const s = seriesOf(0, [0, 0, 0.3, 1.2, 4.5, 2])
  assert.equal(PointSeries.summary(s), 'Dry now · rain in ~15 min, up to moderate')
})

test('summary: raining and building', () => {
  const s = seriesOf(1.2, [1.5, 3, 6.4, 4])
  assert.equal(PointSeries.summary(s), 'Light rain now · moderate rain in 15 min')
})

test('summary: raining and easing off to dry', () => {
  const s = seriesOf(2, [1, 0.4, 0, 0, 0])
  assert.equal(PointSeries.summary(s), 'Light rain now · dry within 15 min')
})

test('summary: steady rain says only what is falling', () => {
  assert.equal(PointSeries.summary(seriesOf(3, [3.2, 3.1, 2.9])), 'Light rain now')
})

test('summary: no reading, and long lead times', () => {
  assert.equal(PointSeries.summary({ points: [], nowMs: null }), 'No radar reading here yet')
  assert.equal(PointSeries.formatLead(90), '1 h 30 min')
  assert.equal(PointSeries.formatLead(120), '2 h')
  assert.equal(PointSeries.formatMm(12.4), '12 mm/h')
})

// The clock, not the scan, is "now": the newest scan is 13-35 min old when the widget reads it.
function clockCase(clockMinutesAfterScan) {
  const scan = Date.parse('2026-10-03T19:10:00Z')
  const iso = (ms) => new Date(ms).toISOString()
  const observed = [{ time: iso(scan), grid: tiny([0, 0, 0, 0, 0, 0, 0, 0]) }]
  // nowcast every 10 min to +150 min: dry until +40, then 2 mm/h
  const nowcast = []
  for (let k = 1; k <= 15; k++) {
    const v = k * 10 >= 40 ? 2 : 0
    nowcast.push({ time: iso(scan + k * 600000), grid: tiny(Array(8).fill(v), Array(8).fill(v)) })
  }
  return PointSeries.build(observed, nowcast, 56.5, 10, scan + clockMinutesAfterScan * 60000)
}

test('build: the clock is now, the scan is kept apart, and the nowcast stops 90 min after the clock', () => {
  const s = clockCase(20)
  assert.equal(s.nowMs - s.scanMs, 20 * 60000)
  assert.equal(PointSeries.ageMinutes(s), 20)
  const last = s.points[s.points.length - 1]
  assert.equal(last.ms - s.nowMs, 90 * 60000)
  assert.equal(PointSeries.coveredMinutes(s), 90)
})

test('a nowcast reaching past 90 min covers the full 90, even when its last kept step is earlier', () => {
  // scan 24 min old: steps at clock-14, -4, +6, ... +86, +96; the +96 step is dropped, but it is covered
  const scan = Date.parse('2026-10-03T20:20:00Z')
  const iso = (ms) => new Date(ms).toISOString()
  const nowcast = []
  for (let k = 1; k <= 12; k++) nowcast.push({ time: iso(scan + k * 600000), grid: tiny(Array(8).fill(0), Array(8).fill(0)) })
  const s = PointSeries.build([{ time: iso(scan), grid: tiny(Array(8).fill(0)) }], nowcast, 56.5, 10, scan + 24 * 60000)
  assert.equal(PointSeries.summary(s), 'Dry · no rain expected in the next 1 h 30 min')
})

test('lead times count from the clock: rain due 40 min after the scan is 20 min away at a 20-min-old scan', () => {
  const s = clockCase(20)
  assert.deepEqual(PointSeries.firstAtLeast(s, 0.1), { mm: 2, minutes: 20 })
  assert.equal(PointSeries.summary(s), 'Dry now · light rain in ~20 min')
})

test('the current value is the nowcast at the clock, interpolated between steps', () => {
  assert.equal(PointSeries.currentMm(clockCase(0)), 0)          // a fresh scan reads as itself
  assert.equal(PointSeries.currentMm(clockCase(35)), 1)         // halfway from +30 (0) to +40 (2)
  assert.equal(PointSeries.summary(clockCase(45)).indexOf('Light rain now'), 0)
})

test('without a clock the newest scan is now, as before', () => {
  const s = series()
  assert.equal(s.nowMs, s.scanMs)
  assert.equal(PointSeries.ageMinutes(s), 0)
})

test('when the nowcast falls short of 90 min, the dry text claims only what it covers', () => {
  const scan = Date.parse('2026-10-03T19:10:00Z')
  const iso = (ms) => new Date(ms).toISOString()
  const nowcast = []
  for (let k = 1; k <= 12; k++) nowcast.push({ time: iso(scan + k * 600000), grid: tiny(Array(8).fill(0), Array(8).fill(0)) })
  const s = PointSeries.build([{ time: iso(scan), grid: tiny(Array(8).fill(0)) }], nowcast, 56.5, 10, scan + 50 * 60000)
  assert.equal(PointSeries.summary(s), 'Dry · no rain expected in the next 1 h 10 min')
})

test('rain in words follows the legend\'s scale', () => {
  const w = PointSeries.intensity
  assert.equal(w(0), null)
  assert.equal(w(0.05), null)
  assert.equal(w(0.1), 'light')
  assert.equal(w(3.9), 'light')
  assert.equal(w(4), 'moderate')
  assert.equal(w(15), 'heavy')
  assert.equal(w(30), 'very heavy')
  assert.equal(w(60), 'extreme')
})

test('summary: a heavier spell in the same word is not news', () => {
  // 1.2 now, 3.5 later: both light, so the line says only what is falling (then when it stops, if it does)
  assert.equal(PointSeries.summary(seriesOf(1.2, [2, 3.5, 3])), 'Light rain now')
})

test('dry best guess: "no rain" only when the chance of rain is low too', () => {
  const s = seriesOf(0, [0, 0.02, 0])
  assert.equal(PointSeries.summary(s, 0.05), 'Dry · no rain expected in the next 15 min')
  assert.equal(PointSeries.summary(s, 0.55), 'Dry now · showers nearby')
  assert.equal(PointSeries.summary(s, PointSeries.NO_RAIN_CHANCE), 'Dry now · showers nearby')
  assert.equal(PointSeries.summary(s, null), 'Dry · no rain expected in the next 15 min')
  // rain in the best guess keeps its timing, whatever the chance
  assert.equal(PointSeries.summary(seriesOf(0, [0, 2, 3]), 0.9), 'Dry now · light rain in ~10 min')
})

test('raining: "dry within" only once more rain is under 10% likely', () => {
  const s = seriesOf(1, [0.5, 0, 0, 0])
  assert.equal(PointSeries.summary(s, 0.9, 52), 'Light rain now · dry within ~50 min')
  assert.equal(PointSeries.summary(s, 0.9, 62), 'Light rain now · dry within ~1 h')
  assert.equal(PointSeries.summary(s, 0.9, 2), 'Light rain now · dry within ~10 min')
  assert.equal(PointSeries.summary(s, 0.9, null), 'Light rain now · may ease off')
  assert.equal(PointSeries.summary(seriesOf(1, [1, 1, 1]), 0.9, null), 'Light rain now')
  // without chances, the best guess as before
  assert.equal(PointSeries.summary(s), 'Light rain now · dry within 10 min')
})
