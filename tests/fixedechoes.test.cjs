const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const zlib = require('node:zlib')
const path = require('node:path')
const FixedEchoes = require('../FixedEchoes.js')

// A nowcast-shaped grid (224 x 160 over the map), rain set per cell by `f(row, col)`.
function grid(f) {
  const { COLS, ROWS, BOUNDS } = FixedEchoes
  const values = new Float32Array(COLS * ROWS)
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) values[r * COLS + c] = f(r, c)
  return { cols: COLS, rows: ROWS, bounds: Object.assign({}, BOUNDS), values }
}
const at = (g, r, c) => g.values[r * g.cols + c]
const CPH = [99, 147]   // the Copenhagen echo's peak cell

test('the mask is the research mask: 100 cells in four patches, Copenhagen 5 x 3', () => {
  assert.equal(FixedEchoes.CELLS.length, 100)
  const patches = FixedEchoes.patches()
  assert.equal(patches.length, 4)
  const cph = patches.find(p => p.includes(CPH[0] * FixedEchoes.COLS + CPH[1]))
  assert.equal(cph.length, 15)
})

test('an echo on a dry map is removed', () => {
  const g = FixedEchoes.fill(grid((r, c) => (r === CPH[0] && c === CPH[1] ? 3 : 0)))
  assert.equal(at(g, CPH[0], CPH[1]), 0)
})

test('uniform rain passes through unchanged', () => {
  const g = FixedEchoes.fill(grid(() => 2))
  for (const [r, c] of FixedEchoes.CELLS) assert.ok(Math.abs(at(g, r, c) - 2) < 1e-6)
})

test('a shower over the patch is carried through from its surroundings', () => {
  // rain everywhere within 6 cells of Copenhagen, plus a strong echo at the peak cell
  const g = FixedEchoes.fill(grid((r, c) =>
    r === CPH[0] && c === CPH[1] ? 20 : (Math.max(Math.abs(r - CPH[0]), Math.abs(c - CPH[1])) <= 6 ? 1.5 : 0)))
  assert.ok(Math.abs(at(g, CPH[0], CPH[1]) - 1.5) < 1e-6)
})

test('cells outside the mask are left alone, and filling twice changes nothing', () => {
  const g = grid((r, c) => (r * 7 + c) % 5)
  const before = Array.from(g.values)
  FixedEchoes.fill(g)
  const masked = new Set(FixedEchoes.CELLS.map(([r, c]) => r * g.cols + c))
  for (let i = 0; i < before.length; i++) if (!masked.has(i)) assert.equal(g.values[i], before[i])
  const once = Array.from(g.values)
  FixedEchoes.fill(g)
  assert.deepEqual(Array.from(g.values), once)
})

test('other grids (another box, other sizes) are not touched', () => {
  const g = { cols: 40, rows: 30, bounds: { west: 8, east: 15.3, south: 54.3, north: 58 }, values: new Float32Array(1200).fill(1) }
  assert.equal(FixedEchoes.applies(g), false)
  const moved = grid(() => 1); moved.bounds.west = 5.1
  assert.equal(FixedEchoes.applies(moved), false)
})

test('matches the research fill on real scans (Denmark-rain-nowcast scripts/fill_fixed_echo.py)', () => {
  const fix = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'fill-parity-fixture.json.gz'))))
  const [r0] = fix.rows, [c0] = fix.cols
  for (const scan of fix.scans) {
    const g = FixedEchoes.fill(grid((r, c) => {
      const row = scan.raw[r - r0]
      return row && row[c - c0] !== undefined ? row[c - c0] : 0
    }))
    let worst = 0
    scan.filled.forEach((row, i) => row.forEach((v, j) => {
      worst = Math.max(worst, Math.abs(at(g, r0 + i, c0 + j) - v))
    }))
    assert.ok(worst < 1e-3, `scan ${scan.time}: largest difference ${worst}`)
  }
})
