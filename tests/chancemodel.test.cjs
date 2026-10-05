const { test } = require('node:test')
const assert = require('node:assert/strict')
const ChanceModel = require('../ChanceModel.js')

// A 40 x 40 grid over a 4 x 4 degree box; rain (mm/h) set per cell by `f(col, row)`.
function grid(f) {
  const cols = 40, rows = 40, values = new Float32Array(cols * rows)
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) values[r * cols + c] = f(c, r)
  return { cols, rows, bounds: { west: 8, east: 12, south: 54, north: 58 }, values }
}
const NOW = Date.parse('2026-09-30T12:00:00Z')
function nowcast(fs) {
  return fs.map((f, k) => ({ time: new Date(NOW + (k + 1) * 600000).toISOString(), grid: grid(f) }))
}

test('the offsets are fixed and roughly standard normal', () => {
  const a = ChanceModel.offsets(2000), b = ChanceModel.offsets(2000)
  assert.deepEqual(a.slice(0, 5), b.slice(0, 5))
  const mx = a.reduce((s, o) => s + o.x, 0) / a.length
  const sx = Math.sqrt(a.reduce((s, o) => s + (o.x - mx) ** 2, 0) / a.length)
  assert.ok(Math.abs(mx) < 0.1 && Math.abs(sx - 1) < 0.1, `${mx} ${sx}`)
})

test('rain everywhere gives certainty, a dry map none', () => {
  const wet = ChanceModel.compute(nowcast(Array(12).fill(() => 2)), 56, 10, NOW)
  assert.ok(wet.steps.every(s => s.chance === 1))
  assert.equal(ChanceModel.rainWithin(wet, 60), 1)
  assert.equal(ChanceModel.dryWithin(wet, 60), 0)
  const dry = ChanceModel.compute(nowcast(Array(12).fill(() => 0)), 56, 10, NOW)
  assert.ok(dry.steps.every(s => s.chance === 0))
  assert.equal(ChanceModel.rainWithin(dry, 120), 0)
  assert.equal(ChanceModel.dryWithin(dry, 30), 1)
})

test('near the edge of rain the chance is uncertain, and spreads with lead time', () => {
  // rain in the western half of the map, the point a few cells east of its edge
  const c = ChanceModel.compute(nowcast(Array(12).fill((col) => (col < 20 ? 2 : 0))), 56, 10.25, NOW)
  assert.equal(c.steps[0].chance, 0)                   // +10 min: 2.5 cells from the edge, sigma about 1 cell
  const late = c.steps[11].chance                       // +120 min: sigma about 13 cells
  assert.ok(late > 0.2 && late < 0.6, `${late}`)
})

test('the chance of rain within a horizon grows with the horizon', () => {
  // rain arriving from the west: its edge moves 2 cells east every step
  const c = ChanceModel.compute(nowcast(Array.from({ length: 12 }, (_, k) => (col) => (col < 12 + 2 * k ? 1 : 0))), 56, 10.2, NOW)
  const a = ChanceModel.rainWithin(c, 30), b = ChanceModel.rainWithin(c, 60), d = ChanceModel.rainWithin(c, 120)
  assert.ok(a <= b && b <= d && d > 0.5, `${a} ${b} ${d}`)
})

test('describe speaks of rain coming when dry, of it stopping when raining', () => {
  const c = ChanceModel.compute(nowcast(Array(12).fill(() => 0)), 56, 10, NOW)
  assert.equal(ChanceModel.describe(c, 0), 'Rain within 30 min 0% · 1 h 0% · 1½ h 0%')
  assert.equal(ChanceModel.describe(c, 1.5), 'Dry for good by 30 min 100% · 1 h 100% · 1½ h 100%')
  assert.equal(ChanceModel.describe(null, 0), '')
  assert.equal(ChanceModel.compute([], 56, 10, NOW), null)
})

test('it reads the unfaded nowcast when there is one', () => {
  const g = grid(() => 0.05)
  g.rawValues = new Float32Array(g.values.length).fill(1)
  const c = ChanceModel.compute([{ time: new Date(NOW + 600000).toISOString(), grid: g }], 56, 10, NOW)
  assert.equal(c.steps[0].chance, 1)
})

test('statements count from the clock; the copies spread by the lead from the scan', () => {
  // rain arrives 40 min after the scan everywhere; read at a 25-min-old scan
  const fs = Array(12).fill(null).map((_, k) => () => ((k + 1) * 10 >= 40 ? 2 : 0))
  const c = ChanceModel.compute(nowcast(fs), 56, 10, NOW, undefined, NOW + 25 * 60000)
  assert.equal(c.steps[3].minutes, 15)                 // +40 from the scan is 15 min from the clock
  assert.equal(ChanceModel.rainWithin(c, 10), 0)       // not yet within 10 min of now
  assert.equal(ChanceModel.rainWithin(c, 20), 1)       // but within 20
  // steps already in the past do not count as "within"
  const past = ChanceModel.compute(nowcast(Array(12).fill(() => 0).map((f, k) => k === 0 ? () => 5 : f)), 56, 10, NOW, undefined, NOW + 25 * 60000)
  assert.equal(ChanceModel.rainWithin(past, 30), 0)
  // the same step's spread is set by its lead from the scan, not by the clock
  const a = ChanceModel.compute(nowcast(fs), 56, 10, NOW)
  assert.deepEqual(c.wet.map((w) => w[5]), a.wet.map((w) => w[5]))
})

test('parts gives the chances as a title and one cell per horizon, for the panel\'s table', () => {
  const c = ChanceModel.compute(nowcast(Array(12).fill(() => 0)), 56, 10, NOW)
  assert.deepEqual(ChanceModel.parts(c, 0), { title: 'Rain within', items: [
    { label: '30 min', percent: '0%' }, { label: '1 h', percent: '0%' }, { label: '1½ h', percent: '0%' }] })
  assert.equal(ChanceModel.parts(c, 1.5).title, 'Dry for good by')
  assert.equal(ChanceModel.parts(null, 0), null)
})

test('dryForGoodBy: the first step from now when dry for good reaches the chance', () => {
  const c = { steps: [{ minutes: -4 }, { minutes: 6 }, { minutes: 16 }, { minutes: 26 }],
    wet: [[true, true, false, false], [true, false, false, false], [true, true, true, false], [true, false, false, true]] }
  assert.equal(ChanceModel.dryForGoodBy(c, 0.5), 16)
  assert.equal(ChanceModel.dryForGoodBy(c, 0.75), 26)
  assert.equal(ChanceModel.dryForGoodBy(c, 0.8), null)
  assert.equal(ChanceModel.dryForGoodBy(null, 0.9), null)
})
