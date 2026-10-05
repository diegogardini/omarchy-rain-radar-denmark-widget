const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ColorScale = require('../ColorScale.js')

test('colorAt is fully transparent at zero and opaque-ish at high intensity', () => {
  assert.deepEqual(ColorScale.colorAt(0), { r: 0, g: 0, b: 0, a: 0 })
  const extreme = ColorScale.colorAt(200)
  assert.equal(extreme.a, 255)
})

test('colorAt interpolates smoothly between stops, never overshoots stop bounds', () => {
  const stops = ColorScale.stops
  for (let i = 0; i < stops.length - 1; i++) {
    const lo = stops[i], hi = stops[i + 1]
    const mid = (lo.mm + hi.mm) / 2
    const c = ColorScale.colorAt(mid)
    for (const ch of ['r', 'g', 'b', 'a']) {
      const [min, max] = lo[ch] <= hi[ch] ? [lo[ch], hi[ch]] : [hi[ch], lo[ch]]
      assert.ok(c[ch] >= min && c[ch] <= max, `${ch} at mm=${mid} should be within [${min},${max}], got ${c[ch]}`)
    }
  }
})

test('cssColorAt returns a valid rgba() string', () => {
  assert.match(ColorScale.cssColorAt(2.5), /^rgba\(\d+,\d+,\d+,[\d.]+\)$/)
})

test('helpers/rain-colorramp.txt stays in sync with ColorScale.js stops', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'rain-colorramp.txt'), 'utf8')
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('nv'))
  const parsed = lines.map((l) => {
    const [mm, r, g, b, a] = l.split(/\s+/).map(Number)
    return { mm, r, g, b, a }
  })
  assert.deepEqual(parsed, ColorScale.stops)
})
