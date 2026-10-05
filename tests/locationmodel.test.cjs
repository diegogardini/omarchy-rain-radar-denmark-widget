const { test } = require('node:test')
const assert = require('node:assert/strict')
const Location = require('../LocationModel.js')
const MapModel = require('../MapModel.js')

test('the Omarchy weather file is parsed with its own coordinates', () => {
  assert.deepEqual(
    Location.parseWeatherLocation('{"name":"Odense","latitude":55.4038,"longitude":10.4024}'),
    { name: 'Odense', latitude: 55.4038, longitude: 10.4024 })
  // coordinates may be stored as strings
  assert.equal(Location.parseWeatherLocation('{"name":"X","latitude":"55.5","longitude":"10.5"}').latitude, 55.5)
})

test('a name-only weather file resolves through the city list, with Danish spellings folded', () => {
  assert.equal(Location.parseWeatherLocation('{"name":"Aarhus"}').latitude, 56.1629)
  assert.equal(Location.parseWeatherLocation('{"name":"København"}').name, 'Copenhagen')
  assert.equal(Location.parseWeatherLocation('{"name":"århus"}').name, 'Aarhus')
  assert.equal(Location.parseWeatherLocation('{"name":"RØNNE"}').name, 'Rønne')
})

test('an unknown name, junk or missing file yields null rather than a guess', () => {
  assert.equal(Location.parseWeatherLocation('{"name":"Malibu"}'), null)
  assert.equal(Location.parseWeatherLocation('not json'), null)
  assert.equal(Location.parseWeatherLocation(''), null)
  assert.equal(Location.parseWeatherLocation(null), null)
  assert.equal(Location.parseWeatherLocation('{"name":"X","latitude":95,"longitude":10}'), null)
  assert.equal(Location.parseWeatherLocation('{"name":"X","latitude":null,"longitude":null}'), null)
})

test('a saved pin needs coordinates and round-trips', () => {
  const pin = { name: 'Odense', latitude: 55.4038, longitude: 10.4024 }
  assert.deepEqual(Location.parseSelection(Location.serializeSelection(pin)), pin)
  assert.equal(Location.parseSelection('{"name":"Odense"}'), null)
  assert.equal(Location.parseSelection('{}'), null)
  assert.equal(Location.parseSelection('nope'), null)
  assert.equal(Location.parseSelection('{"latitude":"","longitude":""}'), null)
})

test('a clicked point is named after a city within range, else left generic', () => {
  // without the town list: the quick-pick cities
  assert.equal(Location.nameForPoint(55.41, 10.40), 'Odense')
  assert.equal(Location.nameForPoint(55.45, 10.45), 'near Odense')
  assert.equal(Location.nameForPoint(55.9, 11.0), 'Pinned location')
  assert.equal(Location.nameForPoint(57.0, 5.5), 'Pinned location') // out at sea
})

test('distanceKm is sensible', () => {
  const d = Location.distanceKm(55.6761, 12.5683, 56.1629, 10.2039) // Copenhagen-Aarhus
  assert.ok(d > 145 && d < 160, String(d))
  assert.equal(Location.distanceKm(55, 10, 55, 10), 0)
})

test('the user pin wins over the Omarchy Weather location', () => {
  const pin = { name: 'Pin', latitude: 55, longitude: 10 }
  const weather = { name: 'Weather', latitude: 56, longitude: 11 }
  assert.equal(Location.resolve(pin, weather).source, 'pin')
  assert.equal(Location.resolve(null, weather).source, 'weather')
  assert.equal(Location.resolve(null, null), null)
})

test('formatCoords', () => {
  assert.equal(Location.formatCoords(55.6761, 12.5683), '55.68°N 12.57°E')
  assert.equal(Location.formatCoords(-1.5, -2.25), '1.50°S 2.25°W')
})

test('every quick-pick city lies inside the map and is unique', () => {
  const seen = new Set()
  for (const c of Location.cities) {
    assert.ok(MapModel.contains(c.latitude, c.longitude), c.name)
    assert.ok(!seen.has(c.name), 'duplicate ' + c.name)
    seen.add(c.name)
  }
})

test('unproject inverts project across the map, and clicks outside the window are detectable', () => {
  for (const [w, h] of [[460, 330], [600, 430], [300, 210]]) {
    for (const [lat, lon] of [[55.6761, 12.5683], [57.0488, 9.9217], [54.2, 5.5], [58.3, 16.2]]) {
      const p = MapModel.project(lat, lon, w, h)
      const back = MapModel.unproject(p.x, p.y, w, h)
      assert.ok(Math.abs(back.latitude - lat) < 1e-9 && Math.abs(back.longitude - lon) < 1e-9)
    }
  }
  const outside = MapModel.unproject(0, 0, 460, 330)
  assert.equal(MapModel.contains(outside.latitude, outside.longitude), false)
  assert.equal(MapModel.contains(55.6, 12.5), true)
  assert.equal(MapModel.unproject(10, 10, 0, 0), null)
})

const Towns = require('../Towns.js').towns

test('town search finds Danish places as typed, ignoring case and the Danish letters', () => {
  const names = (q) => Location.searchTowns(Towns, q, 5).map((m) => m.name)
  assert.equal(names('gille')[0], 'Gilleleje')
  assert.equal(names('kobenhavn')[0], 'København')
  assert.equal(names('Copenhagen')[0], 'København')   // the English name
  assert.equal(names('kbh')[0], 'København')          // a common short form
  assert.equal(names('århus')[0], 'Aarhus')           // the old spelling
  assert.deepEqual(names(''), [])
  assert.deepEqual(names('zzzz'), [])
})

test('town search: an exact name first, then larger places; repeated names say where', () => {
  const m = Location.searchTowns(Towns, 'skærbæk', 5)
  assert.equal(m.length, 5)
  // the South Jutland town (about 3,000 people) before the hamlets of the same name
  assert.ok(Math.abs(m[0].latitude - 55.157) < 0.01 && Math.abs(m[0].longitude - 8.766) < 0.01, JSON.stringify(m[0]))
  assert.equal(m[0].label, 'Skærbæk, near Ribe')
  assert.ok(m.every((x) => x.label.indexOf(', near ') > 0 || x.name !== 'Skærbæk'))
  assert.equal(Location.searchTowns(Towns, 'ry', 3)[0].name, 'Ry')
})

test('the town list covers Denmark and stays inside the map', () => {
  assert.ok(Towns.length > 5000)

  assert.ok(Towns.every((t) => MapModel.contains(t[1], t[2])))
  for (const n of ['København', 'Aarhus', 'Odense', 'Aalborg', 'Esbjerg', 'Rønne', 'Skagen', 'Gedser', 'Tønder'])
    assert.ok(Towns.some((t) => t[0] === n), n)
})

test('the quick picks start with the four largest towns, by population', () => {
  const pop = (name) => {
    const t = Towns.find((r) => r[0] === name || r[5] === name)
    assert.ok(t, name)
    return t[3]
  }
  const four = Location.cities.slice(0, 4).map((c) => pop(c.name))
  for (let i = 1; i < 4; i++) assert.ok(four[i] < four[i - 1], `${Location.cities[i].name} after ${Location.cities[i - 1].name}`)
  const largestRest = Math.max(...Location.cities.slice(4).map((c) => pop(c.name)))
  assert.ok(four[3] > largestRest, 'no later quick pick is larger than the fourth')
})

const MapData = require('../MapData.js')

test('inDenmark: Danish land and the shore count; Sweden, Germany and the open sea do not', () => {
  const dk = (lat, lon) => Location.inDenmark(MapData.denmarkRings, lat, lon, 3)
  for (const [n, lat, lon] of [['Odense', 55.40, 10.40], ['Aarhus', 56.16, 10.20], ['Rønne', 55.10, 14.71],
    ['Skagen', 57.72, 10.58], ['Copenhagen', 55.68, 12.57]]) assert.ok(dk(lat, lon), n)
  for (const [n, lat, lon] of [['Malmö', 55.60, 13.00], ['Hamburg', 53.95, 10.00], ['Gothenburg', 57.71, 11.97],
    ['North Sea', 56.0, 6.5], ['Baltic', 55.0, 13.3]]) assert.ok(!dk(lat, lon), n)
  // a point 1 km off the coast counts with the tolerance, not without it
  assert.ok(!Location.inDenmark(MapData.denmarkRings, 55.53, 8.30, 0) && dk(55.53, 8.30) === Location.inDenmark(MapData.denmarkRings, 55.53, 8.30, 3))
})

test('the remembered "follow my location" choice and wttr.in\'s answer are read safely', () => {
  assert.equal(Location.followsLocation('{"followLocation": true}'), true)
  assert.equal(Location.followsLocation('{}'), false)
  assert.equal(Location.followsLocation('junk'), false)
  const j1 = JSON.stringify({ nearest_area: [{ areaName: [{ value: 'Christianshavn' }], latitude: '55.683', longitude: '12.583' }] })
  assert.deepEqual(Location.parseWttrLocation(j1), { name: 'Christianshavn', latitude: 55.683, longitude: 12.583 })
  assert.equal(Location.parseWttrLocation('{}'), null)
  assert.equal(Location.parseWttrLocation('not json'), null)
})

test('"no place" is read from the saved pin file, and nothing else is mistaken for it', () => {
  assert.equal(Location.noPlace('{"noPlace": true}'), true)
  assert.equal(Location.noPlace('{}'), false)
  assert.equal(Location.noPlace('{"followLocation": true}'), false)
  assert.equal(Location.noPlace('junk'), false)
})

test('a map click is named from the town list: on a place, else near a town', () => {
  const towns = require('../Towns.js').towns
  // Skærbæk in South Jutland (about 3,000 people), clicked on its centre
  assert.equal(Location.nameForPoint(55.1555, 8.7681, towns), 'Skærbæk')
  // central Odense
  assert.equal(Location.nameForPoint(55.3997, 10.3852, towns), 'Odense')
  // a city reaches over its quarters, and keeps the chips' spelling
  assert.equal(Location.nameForPoint(56.1629, 10.2039, towns), 'Aarhus')
  assert.equal(Location.nameForPoint(55.66, 12.52, towns), 'Copenhagen') // Valby
  // open country: never a name that claims to be the place itself
  const name = Location.nameForPoint(56.25, 9.0, towns)
  assert.ok(name.startsWith('near ') || towns.some(t => t[0] === name), name)
  // the North Sea
  assert.equal(Location.nameForPoint(56.5, 6.5, towns), 'Pinned location')
})
