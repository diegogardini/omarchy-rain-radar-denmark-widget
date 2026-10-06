// DMI Radar Data API (STAC) client logic — pure functions, no Process/IO
// here (that lives in DataService.qml), so this is unit-testable with
// `node --test`.
//
// No API key is required as of the Dec 2025 migration to opendataapi.dmi.dk.
// Verified live on 2026-09-17: composite items are ODIM HDF5 files, one per
// 5 minutes alternating between two scan types (see fullRangeOnly), uint8 DBZH grid with gain 0.5 / offset -32 / nodata 255,
// polar-stereographic projection, and a Marshall-Palmer Z-R pair (zr-a=200,
// zr-b=1.6) recorded in the file's /how group — there is no ready-made
// RATE product in the composite collection, so dBZ -> mm/h conversion is
// done explicitly (here, and in helpers/dmi-radar-convert.py for real pixels).

var API_ROOT = "https://opendataapi.dmi.dk/v1/radardata"

// A scan's id becomes a file name in the widget's cache (and the converter's
// input and output), so only DMI's own pattern is accepted: an id from the
// API with anything else (a path, "..", another name) is dropped.
var SCAN_ID = /^dk\.com\.[0-9]{12}\.500_max\.h5$/

function isSafeScanId(id) {
  return typeof id === "string" && SCAN_ID.test(id)
}

function buildItemsUrl(bbox, startIso, endIso, limit) {
  return API_ROOT + "/collections/composite/items"
    + "?bbox=" + encodeURIComponent(bbox)
    + "&datetime=" + encodeURIComponent(startIso + "/" + endIso)
    + "&limit=" + (limit || 300)
}

function downloadUrl(filename) {
  return API_ROOT + "/download/" + encodeURIComponent(filename)
}

// Parses a STAC ItemCollection (FeatureCollection) response into a flat,
// time-sorted list of { id, datetime, downloadUrl, scanType }. Malformed or
// partial entries are skipped defensively, matching the sibling widget's
// parsing style.
function parseItemsResponse(raw) {
  try {
    var data = JSON.parse(String(raw || "{}"))
    var features = Array.isArray(data.features) ? data.features : []
    var items = []
    for (var i = 0; i < features.length; i++) {
      var f = features[i] || {}
      var props = f.properties || {}
      var href = f.asset && f.asset.data && f.asset.data.href
      var id = String(f.id || "")
      var datetime = String(props.datetime || "")
      if (!isSafeScanId(id) || !datetime || !href) continue
      // downloaded from DMI's own address for that id, whatever the response says
      items.push({ id: id, datetime: datetime, downloadUrl: downloadUrl(id), scanType: String(props.scanType || "") })
    }
    items.sort(function(a, b) { return a.datetime < b.datetime ? -1 : (a.datetime > b.datetime ? 1 : 0) })
    return items
  } catch (e) {
    return []
  }
}

// DMI's composite alternates two products every 5 minutes (item property
// `scanType`): "fullRange" at :00, :10, ... and "doppler" at :05, :15, ....
// The doppler composite covers far less of the map (about 21% of the raster
// against 54%); outside its range it has no data, which the conversion can
// only draw as dry. Mixing the two made every other frame lose the rain
// far from the radars, and a motion estimate between a full and a reduced
// scan is mostly measuring the coverage change. So only full-range scans are
// used (verified for every one of 50,619 scans from 2026-04-01 to
// 2026-09-23: full range exactly at minutes divisible by 10; see
// Denmark-rain-nowcast report, Appendix A.1). If DMI ever stops labelling items, all are kept.
function fullRangeOnly(items) {
  var labelled = items.some(function(item) { return !!item.scanType })
  if (!labelled) return items
  return items.filter(function(item) { return item.scanType === "fullRange" })
}

// Only the items not already present in the on-disk frame cache need to be
// downloaded+converted. `cachedIds` is a plain object used as a set.
function newItems(items, cachedIds) {
  cachedIds = cachedIds || {}
  return items.filter(function(item) { return !cachedIds[item.id] })
}

// Marshall-Palmer Z-R relationship: Z = a * R^b (Z in mm^6/m^3, dBZ =
// 10*log10(Z)), inverted to solve for R (mm/h) given dBZ. The same formula as
// helpers/dmi-radar-convert.py's, kept here too so it is unit-tested.
function dbzToRainRate(dbz, zrA, zrB) {
  var a = typeof zrA === "number" ? zrA : 200
  var b = typeof zrB === "number" ? zrB : 1.6
  if (typeof dbz !== "number" || !isFinite(dbz)) return 0
  var z = Math.pow(10, dbz / 10)
  var rate = Math.pow(z / a, 1 / b)
  return isFinite(rate) ? rate : 0
}

// Raw uint8 pixel -> dBZ, given this product's fixed gain/offset/nodata
// (verified against a live sample file on 2026-09-17: gain 0.5, offset -32,
// nodata 255). Returns null for nodata pixels.
function pixelToDbz(raw, gain, offset, nodata) {
  var g = typeof gain === "number" ? gain : 0.5
  var o = typeof offset === "number" ? offset : -32
  var nd = typeof nodata === "number" ? nodata : 255
  if (raw === nd) return null
  return raw * g + o
}

if (typeof module !== "undefined") module.exports = {
  buildItemsUrl: buildItemsUrl,
  isSafeScanId: isSafeScanId,
  downloadUrl: downloadUrl,
  parseItemsResponse: parseItemsResponse,
  fullRangeOnly: fullRangeOnly,
  newItems: newItems,
  dbzToRainRate: dbzToRainRate,
  pixelToDbz: pixelToDbz
}
