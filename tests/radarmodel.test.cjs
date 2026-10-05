const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const RadarModel = require('../RadarModel.js')
const MapModel = require('../MapModel.js')

test('buildItemsUrl encodes bbox and datetime range against the real DMI endpoint shape', () => {
  const url = RadarModel.buildItemsUrl(MapModel.dmiBbox, '2026-09-17T10:00:00Z', '2026-09-17T12:00:00Z')
  assert.equal(url, 'https://opendataapi.dmi.dk/v1/radardata/collections/composite/items?bbox=5%2C53.9%2C16.5%2C58.5&datetime=2026-09-17T10%3A00%3A00Z%2F2026-09-17T12%3A00%3A00Z&limit=300')
})

test('downloadUrl matches the real DMI download resource shape', () => {
  assert.equal(RadarModel.downloadUrl('dk.com.202607200405.500_max.h5'),
    'https://opendataapi.dmi.dk/v1/radardata/download/dk.com.202607200405.500_max.h5')
})

test('parseItemsResponse parses a real captured DMI response fixture, sorted by time', () => {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'radar-items.json'), 'utf8')
  const items = RadarModel.parseItemsResponse(raw)
  assert.ok(items.length >= 2)
  assert.ok(items.every((it) => it.id && it.datetime && it.downloadUrl))
  const sorted = [...items].sort((a, b) => a.datetime < b.datetime ? -1 : 1)
  assert.deepEqual(items, sorted)
})

test('parseItemsResponse tolerates malformed input', () => {
  assert.deepEqual(RadarModel.parseItemsResponse('not json'), [])
  assert.deepEqual(RadarModel.parseItemsResponse('{}'), [])
  assert.deepEqual(RadarModel.parseItemsResponse(null), [])
})

test('newItems filters out already-cached ids', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(RadarModel.newItems(items, { a: true, c: true }), [{ id: 'b' }])
  assert.deepEqual(RadarModel.newItems(items, {}), items)
})

test('dbzToRainRate matches the Marshall-Palmer relationship (a=200, b=1.6)', () => {
  // Z = a*R^b => dBZ = 10*log10(a*R^b); invert both ways as a cross-check.
  const rate = 5
  const z = 200 * Math.pow(rate, 1.6)
  const dbz = 10 * Math.log10(z)
  const recovered = RadarModel.dbzToRainRate(dbz, 200, 1.6)
  assert.ok(Math.abs(recovered - rate) < 1e-9)
})

test('dbzToRainRate is zero for non-finite input', () => {
  assert.equal(RadarModel.dbzToRainRate(NaN), 0)
  assert.equal(RadarModel.dbzToRainRate(undefined), 0)
})

test('pixelToDbz applies the verified gain/offset/nodata and flags nodata as null', () => {
  // Verified against a live sample composite file on 2026-09-17: gain 0.5, offset -32, nodata 255.
  assert.equal(RadarModel.pixelToDbz(64, 0.5, -32, 255), 0)
  assert.equal(RadarModel.pixelToDbz(255, 0.5, -32, 255), null)
  assert.equal(RadarModel.pixelToDbz(0, 0.5, -32, 255), -32)
})

test('fullRangeOnly keeps the full-range scans and drops the short-range doppler ones', () => {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'radar-items.json'), 'utf8')
  const items = RadarModel.parseItemsResponse(raw)
  const kept = RadarModel.fullRangeOnly(items)
  assert.ok(kept.length > 0 && kept.length < items.length)
  assert.ok(kept.every((it) => it.scanType === 'fullRange'))
})

test('fullRangeOnly keeps everything when DMI does not label the scans', () => {
  const items = [{ id: 'a', scanType: '' }, { id: 'b', scanType: '' }]
  assert.deepEqual(RadarModel.fullRangeOnly(items), items)
})
