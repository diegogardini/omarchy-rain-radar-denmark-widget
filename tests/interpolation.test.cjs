const { test } = require('node:test')
const assert = require('node:assert/strict')
const Interpolation = require('../Interpolation.js')

function makeGrid(cols, rows, fill) {
  const values = new Float32Array(cols * rows)
  for (let i = 0; i < values.length; i++) values[i] = fill(i % cols, Math.floor(i / cols))
  return { cols, rows, bounds: { west: 8, east: 15.3, south: 54.3, north: 58 }, values }
}

test('sampleBilinear reproduces exact grid values at integer coordinates', () => {
  const grid = makeGrid(4, 4, (c, r) => c + r * 10)
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      assert.ok(Math.abs(Interpolation.sampleBilinear(grid, c, r) - (c + r * 10)) < 1e-9)
    }
  }
})

test('sampleBilinear interpolates linearly between neighbors', () => {
  const grid = makeGrid(2, 2, (c, r) => (c === 1 ? 10 : 0))
  assert.ok(Math.abs(Interpolation.sampleBilinear(grid, 0.5, 0) - 5) < 1e-9)
})

function blobGrid(size, blockCol, blockRow, blockSize) {
  return makeGrid(size, size, (c, r) =>
    (c >= blockCol && c < blockCol + blockSize && r >= blockRow && r < blockRow + blockSize) ? 10 : 0)
}

// A checkerboard covering the WHOLE grid (no empty background anywhere) so
// every block has real internal structure and a real prior observation to
// match against — avoids the "moved into previously-empty territory" dead
// zone that a small isolated moving blob would hit at its leading edge,
// which is a real, expected limitation of this simple per-block advection
// model (no dis-occlusion / new-information synthesis), not something a
// unit test should be asserting away.
function checkerGrid(size, phase) {
  return makeGrid(size, size, (c, r) => (Math.floor((c + r + phase) / 4) % 2 === 0) ? 10 : 0)
}

function correlation(gridX, gridY) {
  let dot = 0, magX = 0, magY = 0
  for (let i = 0; i < gridX.values.length; i++) {
    dot += gridX.values[i] * gridY.values[i]
    magX += gridX.values[i] * gridX.values[i]
    magY += gridY.values[i] * gridY.values[i]
  }
  return dot / Math.sqrt(magX * magY)
}

test('computeBlockMotion assigns meaningful confidence at realistic rain-rate variance, not just high-contrast synthetic values', () => {
  // Regression test for a real bug: an earlier confidence formula
  // multiplied `improvement` by a variance-based "structure" factor
  // calibrated against this file's own high-contrast test fixtures
  // (values like 0/10), which crushed confidence to ~0.001-0.01 on real
  // DMI rain-rate data (checked live: per-block variance typically
  // 0.001-3 (mm/h)^2) even for blocks with a clean, spatially-consistent
  // match — rendered as clouds that stop moving and just fade in place.
  // This uses a low-contrast (0.3 vs 0.1 mm/h, per-pixel variance ~0.01)
  // checkerboard shift matching the real per-block variance range found
  // live (~0.001-0.02 typical, up to ~3 at the high end) — a synthetic
  // high-contrast pattern (e.g. 0 vs 10) doesn't reproduce the bug, since
  // its variance was never small enough to be crushed by the old formula.
  const smallCheckerGrid = (size, phase) =>
    makeGrid(size, size, (c, r) => (Math.floor((c + r + phase) / 4) % 2 === 0) ? 0.3 : 0.1)
  const gridA = smallCheckerGrid(24, 0)
  const gridB = smallCheckerGrid(24, 4)
  const blocks = Interpolation.computeBlockMotion(gridA, gridB, 4, 5)
  const meanConfidence = blocks.reduce((s, b) => s + b.confidence, 0) / blocks.length
  assert.ok(meanConfidence > 0.3, `expected meaningful mean confidence on realistic-scale data, got ${meanConfidence}`)
})

test('extrapolateSequence continues a whole-field shift in the same direction', () => {
  // The checkerboard shifts by phase 4 (one full period-8 half-cycle)
  // between gridA and gridB. Extrapolating one more step should land on
  // phase 8, which is identical to gridA's own phase-0 pattern shifted by
  // a full period — i.e. pixel-identical to gridA itself.
  const gridA = checkerGrid(24, 0)
  const gridB = checkerGrid(24, 4)
  const expectedNext = checkerGrid(24, 8) // == gridA, but computed independently
  const steps = Interpolation.extrapolateSequence(gridA, gridB, 1, 4, 5, 1.0)
  assert.equal(steps.length, 1)
  const toExpected = correlation(steps[0], expectedNext)
  const toHeldStill = correlation(steps[0], gridB)
  // Axis-aligned 4x4 blocks can't perfectly track a diagonal period-8
  // stripe at every edge, so this doesn't need to be near-exact — it just
  // needs to clearly continue the shift rather than default to holding
  // gridB in place (which correlation with gridB alone would show as high).
  assert.ok(toExpected > 0.6, `expected correlation with the continued shift, got ${toExpected}`)
  assert.ok(toExpected > toHeldStill,
    `should correlate more with the continued shift (${toExpected}) than with holding still (${toHeldStill})`)
})

test('extrapolateSequence never produces negative values', () => {
  const gridA = blobGrid(12, 2, 2, 3)
  const gridB = blobGrid(12, 4, 4, 3)
  const steps = Interpolation.extrapolateSequence(gridA, gridB, 5, 3, 3, 0.2)
  for (const s of steps) assert.ok(s.values.every((v) => v >= 0))
})

test('extrapolateSequence with steps 0 returns an empty array', () => {
  const a = makeGrid(4, 4, () => 1)
  assert.deepEqual(Interpolation.extrapolateSequence(a, a, 0), [])
})

test('smoothBlockMotion propagates confident motion into a low-confidence neighbor', () => {
  // 3x1 block grid: left block confidently moves right, middle block found
  // no reliable match of its own (e.g. a smooth/uniform patch inside a
  // moving rain mass — real signal, but too flat to track in isolation),
  // right block is a separate, weak, unrelated match.
  const blocks = [
    { c0: 0, r0: 0, c1: 8, r1: 8, dx: 4, dy: 0, confidence: 0.9 },
    { c0: 8, r0: 0, c1: 16, r1: 8, dx: 0, dy: 0, confidence: 0 },
    { c0: 16, r0: 0, c1: 24, r1: 8, dx: -3, dy: 2, confidence: 0.05 }
  ]
  const smoothed = Interpolation.smoothBlockMotion(blocks, 3, 1, 1)
  assert.ok(smoothed[1].confidence > 0, 'middle block should inherit confidence from its confident neighbor')
  assert.ok(smoothed[1].dx > 0, `middle block should inherit a rightward dx, got ${smoothed[1].dx}`)
})

test('smoothBlockMotion leaves an already-confident block untouched', () => {
  const blocks = [
    { c0: 0, r0: 0, c1: 8, r1: 8, dx: 4, dy: 0, confidence: 0.9 },
    { c0: 8, r0: 0, c1: 16, r1: 8, dx: -1, dy: -1, confidence: 0.55 }
  ]
  const smoothed = Interpolation.smoothBlockMotion(blocks, 2, 1, 2)
  assert.deepEqual(smoothed[1], blocks[1])
})

test('smoothBlockMotion leaves an isolated low-confidence block unchanged when no neighbor is confident', () => {
  const blocks = [
    { c0: 0, r0: 0, c1: 8, r1: 8, dx: 0, dy: 0, confidence: 0 },
    { c0: 8, r0: 0, c1: 16, r1: 8, dx: 0, dy: 0, confidence: 0 }
  ]
  const smoothed = Interpolation.smoothBlockMotion(blocks, 2, 1, 2)
  assert.deepEqual(smoothed, blocks)
})

test('computeBlockMotion applies smoothing end-to-end: a flat patch inside a moving mass is no longer stuck at zero confidence', () => {
  // A large moving square (much bigger than one block) shifts by 4 cells.
  // Offset by 6 (not a multiple of blockSize=4) so the square's edges fall
  // mid-block, giving the blocks along its boundary real internal contrast
  // to lock onto — the square's own interior stays perfectly uniform (no
  // internal texture), so an interior block's own direct match is
  // ambiguous, exactly the scenario that used to leave broad rain areas
  // visually frozen.
  const gridA = blobGrid(32, 6, 6, 16)
  const gridB = blobGrid(32, 10, 10, 16)
  const blocks = Interpolation.computeBlockMotion(gridA, gridB, 4, 5)
  // (12,12) is well inside gridA's 6-22 footprint, away from any edge.
  const interior = blocks.find((b) => b.c0 === 12 && b.r0 === 12)
  assert.ok(interior, 'expected an interior block at (12,12)')
  assert.ok(interior.confidence > 0, `interior block should have inherited nonzero confidence, got ${interior.confidence}`)
})

function gaussianGrid(cols, rows, cx, cy, sigma, peak) {
  const values = new Float32Array(cols * rows)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      values[r * cols + c] = peak * Math.exp(-(((c - cx) / sigma) ** 2 + ((r - cy) / sigma) ** 2))
  return { cols, rows, bounds: { west: 0, east: 1, south: 0, north: 1 }, values }
}
function argmax(grid) {
  let best = -1, at = 0
  grid.values.forEach((v, i) => { if (v > best) { best = v; at = i } })
  return { col: at % grid.cols, row: Math.floor(at / grid.cols), value: best }
}

test('a small shower keeps its intensity over 24 steps (no numerical blurring)', () => {
  // Advecting by resampling the previous output 24 times used to blur a
  // ~6 km shower to 40% of its peak; sampling the observed grid once must not.
  const a = gaussianGrid(224, 160, 40, 60, 2, 10)
  const b = gaussianGrid(224, 160, 41.3, 60.4, 2, 10)
  const steps = Interpolation.extrapolateSequence(a, b, 24, 8, 6, 1.0)
  assert.equal(steps.length, 24)
  assert.ok(argmax(steps[23]).value > 8, 'peak after 24 steps: ' + argmax(steps[23]).value)
})

test('the shower ends up where the motion says it should after 24 steps', () => {
  const a = gaussianGrid(224, 160, 40, 60, 4, 10)
  const b = gaussianGrid(224, 160, 42, 61, 4, 10) // +2 cols, +1 row per step (the matcher resolves whole cells)
  const steps = Interpolation.extrapolateSequence(a, b, 24, 8, 6, 1.0)
  const peak = argmax(steps[23])
  assert.ok(Math.abs(peak.col - (42 + 48)) <= 2, 'col ' + peak.col)
  assert.ok(Math.abs(peak.row - (61 + 24)) <= 2, 'row ' + peak.row)
})

test('a cleanly tracked shower moves at its measured speed, not a fraction of it', () => {
  // Displacement used to be scaled by match confidence (0.6 for a perfect
  // synthetic match), so this shower crawled at 60% speed and every
  // predicted arrival time was late.
  const a = gaussianGrid(224, 160, 40, 60, 4, 10)
  const b = gaussianGrid(224, 160, 43, 60, 4, 10) // exactly 3 cells per step east
  const steps = Interpolation.extrapolateSequence(a, b, 10, 8, 6, 1.0)
  const peak = argmax(steps[9])
  assert.ok(Math.abs(peak.col - (43 + 30)) <= 1, 'col ' + peak.col)
})

test('motionWeight eases weak matches toward standing still and saturates for good ones', () => {
  assert.equal(Interpolation.motionWeight(0), 0)
  assert.equal(Interpolation.motionWeight(-1), 0)
  assert.ok(Math.abs(Interpolation.motionWeight(0.15) - 0.5) < 1e-9)
  assert.equal(Interpolation.motionWeight(0.6), 1)
  assert.equal(Interpolation.motionWeight(1), 1)
})

test('globalMotion is the confidence-weighted mean, and null when nothing was measured', () => {
  const blk = (dx, dy, confidence) => ({ c0: 0, r0: 0, c1: 8, r1: 8, dx, dy, confidence })
  assert.equal(Interpolation.globalMotion([]), null)
  assert.equal(Interpolation.globalMotion([blk(3, 1, 0), null]), null)
  const one = Interpolation.globalMotion([blk(2, -1, 0.9), blk(9, 9, 0)])
  assert.ok(Math.abs(one.dx - 2) < 1e-9 && Math.abs(one.dy + 1) < 1e-9)
  // a confident block outweighs a weak one
  const mixed = Interpolation.globalMotion([blk(2, 0, 0.9), blk(-2, 0, 0.1)])
  assert.ok(mixed.dx > 1, 'dx ' + mixed.dx)
})

test('global motion puts the shower where the motion says, and keeps its intensity', () => {
  const a = gaussianGrid(224, 160, 40, 60, 4, 10)
  const b = gaussianGrid(224, 160, 42, 61, 4, 10)
  const steps = Interpolation.extrapolateSequence(a, b, 24, 8, 6, 1.0, true)
  const peak = argmax(steps[23])
  assert.ok(Math.abs(peak.col - (42 + 48)) <= 2, 'col ' + peak.col)
  assert.ok(Math.abs(peak.row - (61 + 24)) <= 2, 'row ' + peak.row)
  assert.ok(peak.value > 8, 'peak ' + peak.value)
})

test('global motion keeps the total rain when two showers move differently', () => {
  // A conservation guard only: the per-block field also passes on this clean
  // synthetic scene, so it does not reproduce the 0.5x-2x total swings seen on
  // real scans (docs/FORECAST-VERIFICATION.md section 11); that needs real data.
  const two = (x1, x2) => {
    const g1 = gaussianGrid(224, 160, x1, 40, 4, 10), g2 = gaussianGrid(224, 160, x2, 110, 4, 10)
    return { cols: 224, rows: 160, bounds: g1.bounds, values: g1.values.map((v, i) => v + g2.values[i]) }
  }
  const total = (v) => { let s = 0; for (const x of v) s += x; return s }
  const a = two(40, 40), b = two(42, 41)
  const steps = Interpolation.extrapolateSequence(a, b, 24, 8, 6, 1.0, true)
  const before = total(b.values)
  for (const k of [5, 11, 23]) {
    const ratio = total(steps[k].rawValues) / before
    assert.ok(ratio > 0.95 && ratio < 1.05, `step ${k}: total ${ratio}`)
  }
})

test('global motion with nothing measured holds the field in place', () => {
  const dry = gaussianGrid(64, 48, 20, 20, 4, 0)
  const steps = Interpolation.extrapolateSequence(dry, dry, 3, 8, 4, 1.0, true)
  for (const s of steps) assert.equal(Math.max(...s.rawValues), 0)
})

test('rawGlobalMotion is the plain confidence-weighted mean of the blocks\' own matches', () => {
  const blk = (dx, dy, c) => ({ c0: 0, r0: 0, c1: 8, r1: 8, dx: dx, dy: dy, confidence: c })
  assert.equal(Interpolation.rawGlobalMotion([blk(3, 1, 0), null]), null)
  // a weak match is not scaled down (globalMotion would shrink it toward zero)
  const weak = Interpolation.rawGlobalMotion([blk(2, -1, 0.1)])
  assert.ok(Math.abs(weak.dx - 2) < 1e-9 && Math.abs(weak.dy + 1) < 1e-9)
  const mixed = Interpolation.rawGlobalMotion([blk(2, 0, 0.75), blk(-2, 0, 0.25)])
  assert.ok(Math.abs(mixed.dx - 1) < 1e-9)
})

test('rawBlockMotion is computeBlockMotion before neighbour smoothing', () => {
  const a = gaussianGrid(64, 48, 20, 20, 4, 10), b = gaussianGrid(64, 48, 22, 21, 4, 10)
  const raw = Interpolation.rawBlockMotion(a, b, 8, 4)
  const smoothed = Interpolation.smoothBlockMotion(raw, 8, 6, 2)
  assert.deepEqual(Interpolation.computeBlockMotion(a, b, 8, 4), smoothed)
})

test('globalMotionFromFrames averages the motion over every consecutive pair', () => {
  // a shower moving (2, 1) cells per scan, four scans
  const frames = [0, 1, 2, 3].map((k) => gaussianGrid(224, 160, 40 + 2 * k, 60 + k, 4, 10))
  const v = Interpolation.globalMotionFromFrames(frames, 8, 6)
  assert.ok(Math.abs(v.dx - 2) < 0.3 && Math.abs(v.dy - 1) < 0.3, `got ${v.dx}, ${v.dy}`)
})

test('globalMotionFromFrames is null with fewer than two frames or nothing to track', () => {
  const dry = gaussianGrid(64, 48, 20, 20, 4, 0)
  assert.equal(Interpolation.globalMotionFromFrames([dry], 8, 4), null)
  assert.equal(Interpolation.globalMotionFromFrames([dry, dry, dry], 8, 4), null)
})

test('extrapolateSequence accepts an explicit vector and moves the shower by it', () => {
  const b = gaussianGrid(224, 160, 42, 61, 4, 10)
  const steps = Interpolation.extrapolateSequence(null, b, 24, 8, 6, 1.0, { dx: 2, dy: 1 })
  const peak = argmax(steps[23])
  assert.ok(Math.abs(peak.col - (42 + 48)) <= 2, 'col ' + peak.col)
  assert.ok(Math.abs(peak.row - (61 + 24)) <= 2, 'row ' + peak.row)
  assert.ok(peak.value > 8, 'peak ' + peak.value)
})

test('an explicit vector of zero holds the field in place', () => {
  const b = gaussianGrid(64, 48, 20, 20, 4, 10)
  const steps = Interpolation.extrapolateSequence(null, b, 3, 8, 4, 1.0, { dx: 0, dy: 0 })
  for (const s of steps) assert.ok(Math.abs(argmax(s).col - 20) <= 0 && Math.abs(argmax(s).row - 20) <= 0)
})

test('extrapolateSequence marks the cells whose rain comes from beyond the map edge', () => {
  // 10 x 6 grid, motion 2 cells east per step: after k steps, the first 2k columns look upstream past the west edge
  const cols = 10, rows = 6
  const g = { cols, rows, bounds: { west: 0, east: 10, south: 0, north: 6 }, values: new Float32Array(cols * rows).fill(1) }
  const seq = Interpolation.extrapolateSequence(g, g, 3, 2, 1, 1, { dx: 2, dy: 0 })
  for (let k = 0; k < 3; k++) {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      assert.equal(seq[k].fromEdge[r * cols + c], c < 2 * (k + 1) ? 1 : 0, `step ${k}, cell ${r},${c}`)
    }
    // the edge value is still used (repeated), only marked
    assert.equal(seq[k].rawValues[0], 1)
  }
})

test('pairMotion and meanMotion give exactly globalMotionFromFrames (what DataService caches)', () => {
  const frames = [0, 1, 2, 3].map((s) => checkerGrid(32, s))
  const whole = Interpolation.globalMotionFromFrames(frames, 8, 6)
  const pairs = [0, 1, 2].map((k) => Interpolation.pairMotion(frames[k], frames[k + 1], 8, 6))
  assert.deepEqual(Interpolation.meanMotion(pairs), whole)
  // a pair with nothing measurable is skipped, as before
  assert.deepEqual(Interpolation.meanMotion([pairs[0], null, pairs[2]]),
    { dx: (pairs[0].dx + pairs[2].dx) / 2, dy: (pairs[0].dy + pairs[2].dy) / 2 })
  assert.equal(Interpolation.meanMotion([null, null]), null)
})

test('the nowcast is not faded with lead time: drawn and read values are the predicted rain', () => {
  // a static scene: every step keeps the shower at full strength, whatever the sixth argument says
  const gridA = blobGrid(16, 4, 4, 8)
  const steps = Interpolation.extrapolateSequence(gridA, gridA, 4, 4, 4, 0.3)
  for (const s of steps) {
    assert.ok(Math.abs(Math.max(...s.values) - 10) < 1e-6, `peak ${Math.max(...s.values)}`)
    assert.strictEqual(s.values, s.rawValues)
  }
})
