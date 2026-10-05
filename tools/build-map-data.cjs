#!/usr/bin/env node
// Regenerates MapData.js from Natural Earth 1:10m Admin 0 countries.
//
//   curl -fsSL -o ne10m.geojson https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson
//   node tools/build-map-data.cjs ne10m.geojson > MapData.js
//
// Denmark is the subject of the map, so it gets a fine tolerance (~0.25 px at
// the panel's normal scale: fjords and inlets stay visible, but the ~2200
// source points don't all need drawing). The neighbours are only context, so
// they are clipped to the map domain (MapModel.bounds plus a margin, so the
// artificial clip edges fall outside anything drawn) and simplified the same
// way — Norway's coast alone is ~16000 points, nearly all of it outside the
// domain. Using one source for all of them keeps the shared Danish–German
// border consistent between the two outlines.
const fs = require("node:fs")
const path = require("node:path")
const { bounds } = require(path.join(__dirname, "..", "MapModel.js"))

const MARGIN = 0.3 // degrees beyond the domain kept when clipping
const TOLERANCE = 0.004 // degrees (~400 m, ~0.25 px at the panel's normal scale)
const clipBox = {
  west: bounds.west - MARGIN, east: bounds.east + MARGIN,
  south: bounds.south - MARGIN, north: bounds.north + MARGIN
}

const NEIGHBOURS = [
  { iso: "DEU", name: "Germany" },
  { iso: "SWE", name: "Sweden" },
  { iso: "NOR", name: "Norway" },
  { iso: "POL", name: "Poland" }
]

// Placed on land, clear of coasts and the domain edge (checked by eye against
// a rendered panel, and by tests/maprange.test.cjs against the domain).
const LABELS = [
  { name: "Germany", lon: 9.4, lat: 54.05 },
  { name: "Sweden", lon: 14.6, lat: 56.15 },
  { name: "Norway", lon: 7.2, lat: 58.3 },
  { name: "Poland", lon: 15.8, lat: 54.03 }
]

function exteriorRings(feature) {
  const polys = feature.geometry.type === "MultiPolygon" ? feature.geometry.coordinates : [feature.geometry.coordinates]
  return polys.map((poly) => poly[0])
}

// Sutherland-Hodgman against an axis-aligned box.
function clipRing(ring, box) {
  const edges = [
    { inside: (p) => p[0] >= box.west, hit: (a, b) => lerpAtX(a, b, box.west) },
    { inside: (p) => p[0] <= box.east, hit: (a, b) => lerpAtX(a, b, box.east) },
    { inside: (p) => p[1] >= box.south, hit: (a, b) => lerpAtY(a, b, box.south) },
    { inside: (p) => p[1] <= box.north, hit: (a, b) => lerpAtY(a, b, box.north) }
  ]
  let out = ring.slice(0, -1) // drop the closing duplicate
  for (const edge of edges) {
    const input = out
    out = []
    for (let i = 0; i < input.length; i++) {
      const cur = input[i], prev = input[(i + input.length - 1) % input.length]
      if (edge.inside(cur)) {
        if (!edge.inside(prev)) out.push(edge.hit(prev, cur))
        out.push(cur)
      } else if (edge.inside(prev)) {
        out.push(edge.hit(prev, cur))
      }
    }
    if (out.length === 0) return []
  }
  return out
}
function lerpAtX(a, b, x) { const t = (x - a[0]) / (b[0] - a[0]); return [x, a[1] + t * (b[1] - a[1])] }
function lerpAtY(a, b, y) { const t = (y - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), y] }

// Douglas-Peucker on an open polyline.
function simplify(points, tol) {
  if (points.length < 3) return points
  const keep = new Array(points.length).fill(false)
  keep[0] = keep[points.length - 1] = true
  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()
    let maxD = 0, idx = -1
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(points[i], points[s], points[e])
      if (d > maxD) { maxD = d; idx = i }
    }
    if (maxD > tol) { keep[idx] = true; stack.push([s, idx], [idx, e]) }
  }
  return points.filter((_, i) => keep[i])
}
function distToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

function area(ring) {
  let s = 0
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; s += a[0] * b[1] - b[0] * a[1] }
  return Math.abs(s) / 2
}
const round4 = (ring) => ring.map(([x, y]) => [Number(x.toFixed(4)), Number(y.toFixed(4))])

const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
const find = (iso) => data.features.find((f) => f.properties.ISO_A3 === iso || f.properties.ADM0_A3 === iso)

const denmarkRings = exteriorRings(find("DNK"))
  .map((ring) => simplify(ring, TOLERANCE).slice(0, -1)) // open form, like the neighbours
  .filter((ring) => ring.length >= 3)
  .map(round4)
  .sort((a, b) => b.length - a.length)

const neighbours = NEIGHBOURS.map(({ iso, name }) => {
  const rings = []
  for (const ring of exteriorRings(find(iso))) {
    const clipped = clipRing(ring, clipBox)
    if (clipped.length < 3) continue
    const simple = simplify(clipped.concat([clipped[0]]), TOLERANCE)
    const closed = simple.slice(0, -1)
    if (closed.length < 3 || area(closed) < 0.0004) continue // drop specks
    rings.push(round4(closed))
  }
  rings.sort((a, b) => b.length - a.length)
  return { name, rings }
})

const fmtRing = (r) => "[" + r.map((p) => "[" + p[0] + "," + p[1] + "]").join(",") + "]"
const out = [
  "// Map outlines, [lon, lat] pairs, 4-decimal precision — GENERATED by",
  "// tools/build-map-data.cjs from Natural Earth 1:10m Admin 0 countries",
  "// (public domain). See MAP-SOURCES.md. Do not edit by hand.",
  "var denmarkRings = [",
  denmarkRings.map((r) => "  " + fmtRing(r)).join(",\n"),
  "]",
  "",
  "// Neighbouring countries, clipped to the map domain and simplified.",
  "var neighbours = [",
  neighbours.map((n) => "  { name: " + JSON.stringify(n.name) + ", rings: [\n" + n.rings.map((r) => "    " + fmtRing(r)).join(",\n") + "\n  ] }").join(",\n"),
  "]",
  "",
  "var labels = " + JSON.stringify(LABELS),
  "",
  'if (typeof module !== "undefined") module.exports = { denmarkRings: denmarkRings, neighbours: neighbours, labels: labels }',
  ""
].join("\n")
process.stdout.write(out)
