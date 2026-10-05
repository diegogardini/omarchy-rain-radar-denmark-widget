// Where the rain graph is drawn for: parsing the Omarchy Weather location and
// this plugin's own saved pin, plus naming a clicked point. Pure functions.

// Danish cities offered as quick picks (and used to give a clicked pin a
// human name). Coordinates are town centres, rounded to 4 decimals.
var cities = [
  { name: "Copenhagen", latitude: 55.6761, longitude: 12.5683 },
  { name: "Aarhus", latitude: 56.1629, longitude: 10.2039 },
  { name: "Odense", latitude: 55.4038, longitude: 10.4024 },
  { name: "Aalborg", latitude: 57.0488, longitude: 9.9217 },
  { name: "Esbjerg", latitude: 55.4765, longitude: 8.4594 },
  { name: "Rønne", latitude: 55.1037, longitude: 14.7066 },
  { name: "Roskilde", latitude: 55.6415, longitude: 12.0803 },
  { name: "Kolding", latitude: 55.4904, longitude: 9.4722 },
  { name: "Horsens", latitude: 55.8607, longitude: 9.8503 },
  { name: "Vejle", latitude: 55.7113, longitude: 9.5364 },
  { name: "Herning", latitude: 56.1394, longitude: 8.9737 },
  { name: "Randers", latitude: 56.4607, longitude: 10.0364 },
  { name: "Viborg", latitude: 56.4532, longitude: 9.4020 },
  { name: "Silkeborg", latitude: 56.1697, longitude: 9.5451 },
  { name: "Sønderborg", latitude: 54.9094, longitude: 9.7921 },
  { name: "Næstved", latitude: 55.2299, longitude: 11.7609 },
  { name: "Helsingør", latitude: 56.0361, longitude: 12.6136 },
  { name: "Skagen", latitude: 57.7209, longitude: 10.5839 },
  { name: "Thisted", latitude: 56.9558, longitude: 8.6944 }
]

// Names people type for the same place. Keys are already folded.
var aliases = { "kobenhavn": "Copenhagen", "kbh": "Copenhagen", "arhus": "Aarhus", "ronne": "Rønne",
                "sonderborg": "Sønderborg", "naestved": "Næstved", "helsingor": "Helsingør" }

function trim(value) {
  return String(value === undefined || value === null ? "" : value).replace(/^\s+|\s+$/g, "")
}

function finiteNumber(value) {
  if (value === null || value === undefined || trim(value) === "") return null
  var number = parseFloat(trim(value))
  return isFinite(number) ? number : null
}

// Lower-case, and fold the Danish letters so "København" == "kobenhavn".
function fold(name) {
  return trim(name).toLowerCase()
    .replace(/å/g, "a").replace(/æ/g, "ae").replace(/ø/g, "o")
    .replace(/[^a-z0-9 ]/g, "")
}

function cityByName(name) {
  var key = fold(name)
  if (!key) return null
  if (aliases[key]) key = fold(aliases[key])
  for (var i = 0; i < cities.length; i++) if (fold(cities[i].name) === key) return cities[i]
  return null
}

function validCoords(latitude, longitude) {
  return latitude !== null && longitude !== null &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
}

// Omarchy's settings/weather.json: {"name", "latitude", "longitude"}, where
// the coordinates are optional ("a hand-written {"name": "Malibu"} alone
// works too"). A name without coordinates is resolved against the city list;
// anything else (an unknown name, junk) yields null. With no weather.json at
// all Omarchy detects the location from the IP address (wttr.in); this
// plugin does the same, but only when the user turns "Use location" on
// (parseWttrLocation, followsLocation).
function parseWeatherLocation(raw) {
  try {
    var data = JSON.parse(String(raw || "{}"))
    var name = trim(data.name)
    var latitude = finiteNumber(data.latitude), longitude = finiteNumber(data.longitude)
    if (validCoords(latitude, longitude)) return { name: name, latitude: latitude, longitude: longitude }
    var city = cityByName(name)
    return city ? { name: city.name, latitude: city.latitude, longitude: city.longitude } : null
  } catch (e) {
    return null
  }
}

// This plugin's own saved pin: {"name", "latitude", "longitude"}, coordinates
// required.
function parseSelection(raw) {
  try {
    var data = JSON.parse(String(raw || "{}"))
    var latitude = finiteNumber(data.latitude), longitude = finiteNumber(data.longitude)
    if (!validCoords(latitude, longitude)) return null
    return { name: trim(data.name), latitude: latitude, longitude: longitude }
  } catch (e) {
    return null
  }
}

// Whether the saved pin file says "follow my location" ({"followLocation":
// true}, written by the "Use location" chip when Omarchy has no weather.json).
function followsLocation(raw) {
  try {
    return JSON.parse(String(raw || "{}")).followLocation === true
  } catch (e) {
    return false
  }
}

// Whether the saved pin file says "no place" ({"noPlace": true}: the ✕, or
// "Change place" while following a location). Without it, an empty file
// means "follow the Omarchy weather location, if there is one".
function noPlace(raw) {
  try {
    return JSON.parse(String(raw || "{}")).noPlace === true
  } catch (e) {
    return false
  }
}

// The location Omarchy detects from the IP address when no weather location is
// stored: wttr.in's `?format=j1` answer, nearest_area. {name, latitude,
// longitude} or null. Approximate: it is where the internet connection seems
// to be, often the provider's area.
function parseWttrLocation(raw) {
  try {
    var area = JSON.parse(String(raw || "{}")).nearest_area[0]
    var latitude = finiteNumber(area.latitude), longitude = finiteNumber(area.longitude)
    if (!validCoords(latitude, longitude)) return null
    var name = area.areaName && area.areaName[0] ? trim(area.areaName[0].value) : ""
    return { name: name, latitude: latitude, longitude: longitude }
  } catch (e) {
    return null
  }
}

// Whether a point is in Denmark: inside one of the outlines in `rings`
// (MapData.denmarkRings, [lon, lat] pairs) or within `toleranceKm` of one, so
// a click on the shore or a small island still counts.
function inDenmark(rings, latitude, longitude, toleranceKm) {
  var kx = 111.2 * Math.cos(latitude * Math.PI / 180), ky = 111.2
  var tol = toleranceKm || 0
  for (var r = 0; r < rings.length; r++) {
    var ring = rings[r], inside = false
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1]
      if ((yi > latitude) !== (yj > latitude) && longitude < (xj - xi) * (latitude - yi) / (yj - yi) + xi) inside = !inside
      if (tol > 0) {
        // distance from the point to this edge, in km
        var ax = (xi - longitude) * kx, ay = (yi - latitude) * ky, bx = (xj - longitude) * kx, by = (yj - latitude) * ky
        var dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy
        var t = len > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0
        if (Math.hypot(ax + t * dx, ay + t * dy) <= tol) return true
      }
    }
    if (inside) return true
  }
  return false
}

function serializeSelection(location) {
  return JSON.stringify({ name: location.name || "", latitude: location.latitude, longitude: location.longitude })
}

function distanceKm(latA, lonA, latB, lonB) {
  var rad = Math.PI / 180
  var dLat = (latB - latA) * rad, dLon = (lonB - lonA) * rad
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(latA * rad) * Math.cos(latB * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)))
}

// A clicked point's name, from the town search's places (Towns.js rows:
// [name, latitude, longitude, population, ...]; without them, the quick-pick
// cities). On a place: its name ("Skærbæk"); with several there, the most
// important (the list's order: a city before its quarters). A place reaches
// as far as its people would cover at URBAN_DENSITY per km² (a circle:
// Copenhagen about 8 km, Aarhus 5 km, Odense 4 km), at least ON_PLACE_KM,
// about what a click on the map can tell apart. Else "near" the nearest town of
// at least NEAR_TOWN_POP people within NEAR_TOWN_KM ("near Tønder"), else
// the nearest place of any size within NEAR_ANY_KM, else "Pinned location"
// (out at sea, or far from any place).
var ON_PLACE_KM = 1.5, NEAR_TOWN_KM = 12, NEAR_TOWN_POP = 1000, NEAR_ANY_KM = 6, URBAN_DENSITY = 3000

function reachKm(population) {
  return Math.max(ON_PLACE_KM, Math.sqrt((population || 0) / (Math.PI * URBAN_DENSITY)))
}

function nameForPoint(latitude, longitude, towns) {
  var rows = towns && towns.length ? towns : cities.map(function(c) { return [c.name, c.latitude, c.longitude, NEAR_TOWN_POP] })
  var on = null, any = null, anyKm = Infinity, town = null, townKm = Infinity
  for (var i = 0; i < rows.length; i++) {
    var t = rows[i]
    if (Math.abs(t[1] - latitude) > 0.2 || Math.abs(t[2] - longitude) > 0.35) continue // farther than NEAR_TOWN_KM
    var km = distanceKm(latitude, longitude, t[1], t[2])
    if (!on && km <= reachKm(t[3])) on = t // rows come most important first
    if (km < anyKm) { anyKm = km; any = t }
    if (t[3] >= NEAR_TOWN_POP && km < townKm) { townKm = km; town = t }
  }
  // the quick picks' spelling for their cities ("Copenhagen", as on the chip)
  var named = function(t) { var c = cityByName(t[0]); return c ? c.name : t[0] }
  if (on) return named(on)
  if (town && townKm <= NEAR_TOWN_KM) return "near " + named(town)
  if (any && anyKm <= NEAR_ANY_KM) return "near " + named(any)
  return "Pinned location"
}

function formatCoords(latitude, longitude) {
  return Math.abs(latitude).toFixed(2) + "°" + (latitude >= 0 ? "N" : "S") + " " +
    Math.abs(longitude).toFixed(2) + "°" + (longitude >= 0 ? "E" : "W")
}

// The location the graph should use: the user's own pin wins over the
// Omarchy Weather location; either may be absent.
function resolve(selection, weather) {
  if (selection) return { name: selection.name, latitude: selection.latitude, longitude: selection.longitude, source: "pin" }
  if (weather) return { name: weather.name, latitude: weather.latitude, longitude: weather.longitude, source: "weather" }
  return null
}

// Danish places matching what is being typed, for the panel's town search:
// up to `limit` of {name, latitude, longitude, label}, best first. `towns` is
// Towns.js's list ([name, lat, lon, population, near, English name], most
// important first). Case and the Danish letters are ignored ("kobenhavn"
// finds København, "copenhagen" too); a name that is the query ranks first,
// then names starting with it, then names with a word starting with it, each
// in the list's order. Repeated names carry a hint: "Skærbæk, near Ribe".
function searchTowns(towns, query, limit) {
  var q = fold(query)
  if (!q || !towns) return []
  var alt = aliases[q] ? fold(aliases[q]) : ""
  var max = limit || 5
  var found = [[], [], []]
  for (var i = 0; i < towns.length; i++) {
    var t = towns[i]
    var rank = 3
    var keys = [fold(t[0]), t[5] ? fold(t[5]) : ""]
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k]
      if (!key) continue
      if (key === q || (alt && key === alt)) rank = Math.min(rank, 0)
      else if (key.indexOf(q) === 0) rank = Math.min(rank, 1)
      else if (key.indexOf(" " + q) >= 0) rank = Math.min(rank, 2)
    }
    if (rank < 3 && found[rank].length < max) found[rank].push(t)
  }
  var best = found[0].concat(found[1], found[2]).slice(0, max)
  return best.map(function(t) {
    return { name: t[0], latitude: t[1], longitude: t[2], label: t[4] ? t[0] + ", near " + t[4] : t[0] }
  })
}

if (typeof module !== "undefined") module.exports = {
  cities: cities,
  followsLocation: followsLocation,
  noPlace: noPlace,
  parseWttrLocation: parseWttrLocation,
  inDenmark: inDenmark,
  searchTowns: searchTowns,
  fold: fold,
  cityByName: cityByName,
  parseWeatherLocation: parseWeatherLocation,
  parseSelection: parseSelection,
  serializeSelection: serializeSelection,
  distanceKm: distanceKm,
  nameForPoint: nameForPoint,
  formatCoords: formatCoords,
  resolve: resolve
}
