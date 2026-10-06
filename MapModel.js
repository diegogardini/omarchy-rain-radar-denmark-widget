// A local equirectangular map, longitude scaled at 56 degrees north (near
// Denmark's mid-latitude). Drawing, the radar PNG warp, the nowcast grid
// and DMI's radar API query all share `bounds`, so the raster and the
// vector coastlines line up without any per-frame reprojection.
//
// The domain is deliberately much larger than Denmark: it takes in the
// North Sea to the west (weather arrives from there, so rain has to be
// in-frame *before* it reaches the coast for the nowcast to carry it in),
// the Skagerrak/Kattegat/Baltic, and the neighbouring countries for context.
// helpers/dmi-radar-convert.py keeps its own copy of these numbers (Python
// can't import this) — tests/maprange.test.cjs fails if they drift apart.
var bounds = { west: 5.0, east: 16.5, south: 53.9, north: 58.5 }
var longitudeScale = Math.cos(56 * Math.PI / 180)

// What the panel shows: the data area without its westernmost degree of
// North Sea, so Denmark sits further left and the pin's graph fits over
// Sweden in the upper right. Only the drawing uses it: the radar data, the
// nowcast and the grids keep `bounds` (rain still comes in from the west in
// the forecast; it just shows up on screen about 60 km later).
var view = { west: 6.0, east: 16.5, south: 53.9, north: 58.5 }

// Width / height of the view as drawn (longitude scaled). RadarMap sizes its
// canvas from this so the map fills the panel instead of letterboxing.
var aspect = (view.east - view.west) * longitudeScale / (view.north - view.south)
// The same for the whole data area (the radar PNG is warped to it).
var dataAspect = (bounds.east - bounds.west) * longitudeScale / (bounds.north - bounds.south)

// The Denmark region: the bar icon's peak rain rate is taken over this box,
// not the whole map, so rain over Poland or the North Sea doesn't drive it.
// It is also the research's scoring area (Denmark-rain-nowcast, 8-15.3 E,
// 54.3-58 N).
var denmarkBounds = { west: 8, east: 15.3, south: 54.3, north: 58 }

// "west,south,east,north" — the exact form DMI's radar API expects for its
// bbox query parameter (verified against opendataapi.dmi.dk on 2026-09-17).
function bboxString(b) { return b.west + "," + b.south + "," + b.east + "," + b.north }
var dmiBbox = bboxString(bounds)

// The view's placement in a width x height canvas: its top-left corner (x, y)
// and pixels per degree of latitude (scale).
function viewport(width, height) {
  var scale = Math.max(0, Math.min(
    (width - 16) / ((view.east - view.west) * longitudeScale),
    (height - 16) / (view.north - view.south)))
  return {
    scale: scale,
    x: (width - (view.east - view.west) * longitudeScale * scale) / 2,
    y: (height - (view.north - view.south) * scale) / 2
  }
}

function project(latitude, longitude, width, height) {
  var vp = viewport(width, height)
  return {
    x: vp.x + (longitude - view.west) * longitudeScale * vp.scale,
    y: vp.y + (view.north - latitude) * vp.scale
  }
}

// Inverse of project(): a pixel in a width x height map view back to
// {latitude, longitude}. Used to turn a click into a pin.
function unproject(x, y, width, height) {
  var vp = viewport(width, height)
  if (vp.scale <= 0) return null
  return {
    latitude: view.north - (y - vp.y) / vp.scale,
    longitude: view.west + (x - vp.x) / (longitudeScale * vp.scale)
  }
}

// Whether a point falls inside the area radar data covers.
function contains(latitude, longitude) {
  return latitude >= bounds.south && latitude <= bounds.north &&
    longitude >= bounds.west && longitude <= bounds.east
}

// Whether a point falls inside what the panel shows.
function inView(latitude, longitude) {
  return latitude >= view.south && latitude <= view.north &&
    longitude >= view.west && longitude <= view.east
}

// Highest value among the cells of `grid` ({cols, rows, bounds, values})
// whose centers fall inside `region`. Grids here may cover more than the
// region (the map-wide nowcast grid) or exactly it.
function regionPeak(grid, region) {
  if (!grid || !grid.values || !grid.bounds) return 0
  var cellLon = (grid.bounds.east - grid.bounds.west) / grid.cols
  var cellLat = (grid.bounds.north - grid.bounds.south) / grid.rows
  var max = 0
  for (var row = 0; row < grid.rows; row++) {
    var lat = grid.bounds.north - (row + 0.5) * cellLat
    if (lat < region.south || lat > region.north) continue
    for (var col = 0; col < grid.cols; col++) {
      var lon = grid.bounds.west + (col + 0.5) * cellLon
      if (lon < region.west || lon > region.east) continue
      var v = grid.values[row * grid.cols + col]
      if (v > max) max = v
    }
  }
  return max
}

if (typeof module !== "undefined") module.exports = {
  bounds: bounds,
  longitudeScale: longitudeScale,
  aspect: aspect,
  view: view,
  dataAspect: dataAspect,
  inView: inView,
  denmarkBounds: denmarkBounds,
  dmiBbox: dmiBbox,
  viewport: viewport,
  project: project,
  unproject: unproject,
  contains: contains,
  regionPeak: regionPeak
}
