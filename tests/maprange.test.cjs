const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const MapModel = require('../MapModel.js')
const MapData = require('../MapData.js')

const helper = fs.readFileSync(path.join(__dirname, '..', 'helpers', 'dmi-radar-to-png'), 'utf8')
const shellNumber = (name) => {
  const m = helper.match(new RegExp('^' + name + '=(-?[0-9.]+)\\s*$', 'm'))
  assert.ok(m, `helpers/dmi-radar-to-png should define ${name}=<number>`)
  return Number(m[1])
}

test('helpers/dmi-radar-to-png map domain matches MapModel.bounds', () => {
  assert.equal(shellNumber('dk_west'), MapModel.bounds.west)
  assert.equal(shellNumber('dk_east'), MapModel.bounds.east)
  assert.equal(shellNumber('dk_south'), MapModel.bounds.south)
  assert.equal(shellNumber('dk_north'), MapModel.bounds.north)
})

test('the Denmark region lies inside the map domain', () => {
  const b = MapModel.bounds, h = MapModel.denmarkBounds
  assert.ok(h.west >= b.west && h.east <= b.east && h.south >= b.south && h.north <= b.north)
})

test('radar PNG size has the map domain\'s aspect ratio (else it would be stretched against the coastlines)', () => {
  const pngAspect = shellNumber('out_width') / shellNumber('out_height')
  assert.ok(Math.abs(pngAspect / MapModel.dataAspect - 1) < 0.005, `png aspect ${pngAspect} vs map ${MapModel.dataAspect}`)
})

test('nowcast grid cells are ~square on the ground', () => {
  const b = MapModel.bounds
  const cellEast = (b.east - b.west) * MapModel.longitudeScale / shellNumber('nowcast_grid_cols')
  const cellNorth = (b.north - b.south) / shellNumber('nowcast_grid_rows')
  assert.ok(Math.abs(cellEast / cellNorth - 1) < 0.01, `cells ${cellEast} x ${cellNorth} deg`)
})

test('viewport fills a canvas sized from aspect exactly, with the 8px margin all round', () => {
  const width = 430
  const height = (width - 16) / MapModel.aspect + 16
  const vp = MapModel.viewport(width, height)
  assert.ok(Math.abs(vp.x - 8) < 1e-6 && Math.abs(vp.y - 8) < 1e-6, `origin ${vp.x},${vp.y}`)
  const corner = MapModel.project(MapModel.view.south, MapModel.view.east, width, height)
  assert.ok(Math.abs(corner.x - (width - 8)) < 1e-6 && Math.abs(corner.y - (height - 8)) < 1e-6)
})

test('regionPeak only looks at cells whose centers are inside the region', () => {
  const grid = { cols: 4, rows: 2, bounds: { west: 0, east: 4, south: 0, north: 2 }, values: new Float32Array(8) }
  grid.values[0] = 9 // row 0, col 0 -> center (0.5, 1.5)
  grid.values[7] = 3 // row 1, col 3 -> center (3.5, 0.5)
  assert.equal(MapModel.regionPeak(grid, { west: 0, east: 4, south: 0, north: 2 }), 9)
  assert.equal(MapModel.regionPeak(grid, { west: 2, east: 4, south: 0, north: 2 }), 3)
  assert.equal(MapModel.regionPeak(grid, { west: 0, east: 1, south: 0, north: 1 }), 0)
  assert.equal(MapModel.regionPeak(null, MapModel.denmarkBounds), 0)
})

const pad = 0.31 // build-map-data clips to the domain plus 0.3 degrees
const inPaddedDomain = ([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat) &&
  lon >= MapModel.bounds.west - pad && lon <= MapModel.bounds.east + pad &&
  lat >= MapModel.bounds.south - pad && lat <= MapModel.bounds.north + pad

test('map data: Denmark is complete and the four neighbours are present, clipped to the domain', () => {
  // Detail floor: the 1:50m outline this replaced had 12 rings / 298 points;
  // the 1:10m one (simplified to ~0.25px) is ~4x that. Guards against
  // silently regenerating from coarser data or simplifying too hard.
  assert.ok(MapData.denmarkRings.length >= 12)
  assert.ok(MapData.denmarkRings.reduce((n, r) => n + r.length, 0) > 900, 'Denmark outline lost detail')
  for (const ring of MapData.denmarkRings) for (const p of ring) {
    assert.ok(p[0] >= MapModel.bounds.west && p[0] <= MapModel.bounds.east && p[1] >= MapModel.bounds.south && p[1] <= MapModel.bounds.north)
  }
  assert.deepEqual(MapData.neighbours.map((n) => n.name), ['Germany', 'Sweden', 'Norway', 'Poland'])
  for (const n of MapData.neighbours) {
    assert.ok(n.rings.length > 0, `${n.name} should have visible land in the domain`)
    for (const ring of n.rings) {
      assert.ok(ring.length >= 3)
      assert.ok(ring.every(inPaddedDomain), `${n.name} has points outside the clip box`)
    }
  }
})

function inRing(ring, [x, y]) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

test('each country label sits on that country\'s land, inside the visible domain', () => {
  const b = MapModel.bounds
  for (const label of MapData.labels) {
    assert.ok(label.lon > b.west && label.lon < b.east && label.lat > b.south && label.lat < b.north, `${label.name} outside domain`)
    const country = MapData.neighbours.find((n) => n.name === label.name)
    assert.ok(country, `${label.name} is not a known neighbour`)
    assert.ok(country.rings.some((r) => inRing(r, [label.lon, label.lat])), `${label.name} label is not on ${label.name}'s land`)
  }
})

test('the view is the data area without its westernmost degree, and lies inside it', () => {
  const b = MapModel.bounds, v = MapModel.view
  assert.ok(v.west >= b.west && v.east <= b.east && v.south >= b.south && v.north <= b.north)
  assert.equal(v.west, 6.0)
  assert.ok(MapModel.contains(58, 5.5) && !MapModel.inView(58, 5.5))
  // project and unproject stay inverses in the view
  const p = MapModel.project(55.68, 12.57, 430, 330), q = MapModel.unproject(p.x, p.y, 430, 330)
  assert.ok(Math.abs(q.latitude - 55.68) < 1e-9 && Math.abs(q.longitude - 12.57) < 1e-9)
})
