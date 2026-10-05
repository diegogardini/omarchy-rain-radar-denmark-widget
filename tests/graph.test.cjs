const {test} = require('node:test')
const assert = require('node:assert/strict')
const graph = require('../GraphModel.js')

test('dry is exactly zero; increasing rain stays on a fixed, bounded scale', () => {
  assert.equal(graph.heightFraction(0), 0)
  assert.equal(graph.yFor(0, 10, 210), 210)
  assert.equal(graph.heightFraction(1), 1 / 3)
  let previous = 0
  for (const mm of [0.001, 0.01, 0.1, 0.5, 1, 2.5, 10, 50, 100, 1000, 40000]) {
    const height = graph.heightFraction(mm)
    assert.ok(height > previous && height < 1)
    previous = height
  }
  for (const value of [-1, NaN, Infinity]) assert.equal(graph.heightFraction(value), 0)
})

test('light rain has more visual separation than heavy versus very heavy', () => {
  assert.ok(graph.heightFraction(0.1) < 0.1)
  assert.ok(graph.heightFraction(1) - graph.heightFraction(0.1) > graph.heightFraction(50) - graph.heightFraction(10))
})

test('small changes near zero stay proportional instead of being amplified', () => {
  const firstStep = graph.heightFraction(0.05)
  const secondStep = graph.heightFraction(0.1) - graph.heightFraction(0.05)
  assert.ok(secondStep / firstStep > 0.9)
  assert.ok(graph.heightFraction(0.21) - graph.heightFraction(0.2) < 0.005)
})

test('smooth interpolation stays within neighboring samples, including dry intervals and spikes', () => {
  for (const values of [[0, 0, 0], [0, 50, 0], [0, 0.01, 10, 100, 0.1, 0],
    [1, 1.01, 40, 41, 0, 0, 0.2], [0, 0.01, 0.02, 0.01, 0]]) {
    const points = values.map((mm, i) => ({x:i * 20, y:graph.yFor(mm, 10, 210)}))
    const slopes = graph.tangents(points)
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i+1], dx = b.x-a.x
      for (let j = 0; j <= 100; j++) {
        const t = j/100, u = 1-t
        const y = u*u*u*a.y + 3*u*u*t*(a.y+slopes[i]*dx/3)
          + 3*u*t*t*(b.y-slopes[i+1]*dx/3) + t*t*t*b.y
        assert.ok(y >= Math.min(a.y,b.y)-1e-9 && y <= Math.max(a.y,b.y)+1e-9)
      }
    }
  }
  assert.deepEqual(graph.tangents([{x:0,y:210}]), [0])
})

test('the chance line starts at now: past steps dropped, a point at now interpolated', () => {
  const m = 60000
  const steps = [{ ms: 10 * m, minutes: -11, chance: 0.2 }, { ms: 20 * m, minutes: -1, chance: 0.4 },
    { ms: 30 * m, minutes: 9, chance: 0.6 }, { ms: 40 * m, minutes: 19, chance: 0.5 }]
  const out = graph.chanceFromNow(steps, 21 * m)
  assert.deepEqual(out.map(s => s.ms), [21 * m, 30 * m, 40 * m])
  assert.ok(Math.abs(out[0].chance - 0.42) < 1e-9)
  assert.deepEqual(graph.chanceFromNow(steps, 20 * m).map(s => s.ms), [20 * m, 30 * m, 40 * m])
  assert.deepEqual(graph.chanceFromNow(steps, 5 * m), steps)
})

test('chance strip: no chance is blank, low chances plainly visible, order kept', () => {
  assert.equal(graph.stripAlpha(0), 0)
  assert.equal(graph.stripAlpha(1), 1)
  assert.ok(graph.stripAlpha(0.25) >= 0.5)
  for (let c = 0.05; c < 1; c += 0.05) assert.ok(graph.stripAlpha(c + 0.05) > graph.stripAlpha(c))
})
