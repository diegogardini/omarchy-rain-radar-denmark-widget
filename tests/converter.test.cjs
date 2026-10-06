const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const { execFileSync } = require('node:child_process')

// A real DMI full-range scan (30 July 2026, 18:30 UTC, showers over Zealand),
// converted by helpers/dmi-radar-convert.py and compared with the grid GDAL
// made from the same file (gdalwarp -r average, as the widget used until 1.1).
const fixture = path.join(__dirname, 'fixtures', 'dmi-scan-20260730-1830.h5')
const gdal = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'dmi-scan-20260730-1830.gdal-grid.json.gz'))))

function convert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rain-radar-convert-'))
  try {
    execFileSync('python3', [path.join(__dirname, '..', 'helpers', 'dmi-radar-convert.py'), fixture, path.join(dir, 'scan')])
    return {
      grid: JSON.parse(fs.readFileSync(path.join(dir, 'scan.nowcast-grid.json'), 'utf8')),
      png: fs.readFileSync(path.join(dir, 'scan.png')),
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
const out = convert()

test('the grid has the widget\'s shape and box', () => {
  assert.equal(out.grid.cols, 224)
  assert.equal(out.grid.rows, 160)
  assert.deepEqual(out.grid.bounds, { west: 5, south: 53.9, east: 16.5, north: 58.5 })
  assert.equal(out.grid.values.length, 224 * 160)
})

test('the grid matches GDAL\'s on a real scan', () => {
  const a = gdal.values, b = out.grid.values, n = a.length
  const sum = (v) => v.reduce((s, x) => s + x, 0)
  const ma = sum(a) / n, mb = sum(b) / n
  let cov = 0, va = 0, vb = 0, wetA = 0, wetB = 0, both = 0
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2
    wetA += a[i] >= 0.1; wetB += b[i] >= 0.1; both += a[i] >= 0.1 && b[i] >= 0.1
  }
  const corr = cov / Math.sqrt(va * vb)
  assert.ok(corr > 0.999, `correlation ${corr}`)
  assert.ok(Math.abs(sum(b) / sum(a) - 1) < 0.01, `total ${sum(b) / sum(a)}`)
  assert.ok(both / Math.max(wetA, wetB) > 0.99, `wet cells ${wetA} / ${wetB}, both ${both}`)
})

test('the map image is a 640 x 458 RGBA PNG', () => {
  assert.deepEqual([...out.png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(out.png.readUInt32BE(16), 640)
  assert.equal(out.png.readUInt32BE(20), 458)
  assert.equal(out.png[25], 6) // colour type RGBA
})

test('a file that is not a DMI scan stops with exit code 2, not a wrong picture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rain-radar-convert-'))
  try {
    const bad = path.join(dir, 'bad.h5')
    fs.writeFileSync(bad, 'not an HDF5 file')
    let code = 0
    try { execFileSync('python3', [path.join(__dirname, '..', 'helpers', 'dmi-radar-convert.py'), bad, path.join(dir, 'out')], { stdio: 'pipe' }) } catch (e) { code = e.status }
    assert.equal(code, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a damaged file, or an output outside its folder, is refused with exit code 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rain-radar-convert-'))
  const run = (input, out) => {
    try { execFileSync('python3', [path.join(__dirname, '..', 'helpers', 'dmi-radar-convert.py'), input, out], { stdio: 'pipe' }); return 0 } catch (e) { return e.status }
  }
  try {
    const whole = fs.readFileSync(fixture)
    // cut short: pointers into the missing part must not crash or read past the end
    const cut = path.join(dir, 'cut.h5')
    fs.writeFileSync(cut, whole.subarray(0, 60000))
    assert.equal(run(cut, path.join(dir, 'out')), 2)
    // a chunk's compressed bytes damaged
    const bent = Buffer.from(whole)
    for (let i = 20000; i < 20400; i++) bent[i] ^= 0x5a
    const bad = path.join(dir, 'bent.h5')
    fs.writeFileSync(bad, bent)
    assert.equal(run(bad, path.join(dir, 'out')), 2)
    // the output name may not leave its folder
    assert.equal(run(fixture, path.join(dir, '..', '..', 'tmp', '.hidden')), 2)
    assert.equal(fs.existsSync(path.join(dir, 'out.png')), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a group or chunk tree that repeats an entry is refused at once (no repeated parsing)', () => {
  const whole = fs.readFileSync(fixture)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rain-radar-convert-'))
  const run = (bytes) => {
    const p = path.join(dir, 'x.h5')
    fs.writeFileSync(p, bytes)
    const t = Date.now()
    let code = 0
    try { execFileSync('python3', [path.join(__dirname, '..', 'helpers', 'dmi-radar-convert.py'), p, path.join(dir, 'out')], { stdio: 'pipe', timeout: 20000 }) } catch (e) { code = e.status }
    return { code, ms: Date.now() - t }
  }
  try {
    // the root group's B-tree (superblock 0 caches its address in the root entry's
    // scratch space): list its symbol node twice
    const btree = Number(whole.readBigUInt64LE(56 + 24))
    assert.equal(whole.toString('latin1', btree, btree + 4), 'TREE')
    const twice = Buffer.from(whole)
    twice.writeUInt16LE(2, btree + 6)                        // two entries used
    twice.writeBigUInt64LE(whole.readBigUInt64LE(btree + 24), btree + 40) // key 1 = key 0
    twice.writeBigUInt64LE(whole.readBigUInt64LE(btree + 32), btree + 48) // child 1 = child 0
    const r1 = run(twice)
    assert.equal(r1.code, 2)
    assert.ok(r1.ms < 10000, `took ${r1.ms} ms`)
    // the same node claiming 65535 entries: over budget before any is read
    const many = Buffer.from(whole)
    many.writeUInt16LE(65535, btree + 6)
    assert.equal(run(many).code, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
