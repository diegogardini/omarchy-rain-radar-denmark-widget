// Rain-intensity color ramp, in mm/h. This stays fixed to meteorological
// convention (light blue -> blue -> green -> yellow -> orange -> red ->
// magenta) rather than following the active Omarchy theme: decoded rainfall
// intensity is semantic data where cross-app legibility (the colors a user
// already associates with "light drizzle" vs "extreme downpour") matters
// more than matching a theme's accent hue, and a theme-tinted ramp risks
// colliding with "extreme rain = red" on themes whose accent is itself red.
//
// helpers/rain-colorramp.txt (used by gdaldem color-relief for the observed
// radar path) must be kept in sync with these exact stops by hand — see the
// comment there, and tests/colorscale.test.cjs which parses both and
// asserts they match.
var stops = [
  { mm: 0, r: 0, g: 0, b: 0, a: 0 },
  { mm: 0.1, r: 180, g: 225, b: 255, a: 40 },
  { mm: 0.5, r: 120, g: 196, b: 255, a: 110 },
  { mm: 1, r: 66, g: 146, b: 244, a: 170 },
  { mm: 2.5, r: 52, g: 180, b: 138, a: 205 },
  { mm: 5, r: 105, g: 201, b: 70, a: 220 },
  { mm: 10, r: 240, g: 214, b: 60, a: 230 },
  { mm: 20, r: 240, g: 140, b: 40, a: 240 },
  { mm: 35, r: 219, g: 60, b: 53, a: 245 },
  { mm: 60, r: 178, g: 50, b: 196, a: 250 },
  { mm: 100, r: 120, g: 20, b: 140, a: 255 }
]

function lerp(a, b, t) { return a + (b - a) * t }

// Returns "rgba(r,g,b,a)" for a given rain rate in mm/h, linearly
// interpolated between the nearest stops (a smooth gradient reads better on
// a small radar map than discrete bands).
function colorAt(mm) {
  var value = typeof mm === "number" && isFinite(mm) ? Math.max(0, mm) : 0
  if (value <= stops[0].mm) return { r: stops[0].r, g: stops[0].g, b: stops[0].b, a: stops[0].a }
  for (var i = 1; i < stops.length; i++) {
    if (value <= stops[i].mm) {
      var lo = stops[i - 1], hi = stops[i]
      var t = (value - lo.mm) / (hi.mm - lo.mm)
      return {
        r: Math.round(lerp(lo.r, hi.r, t)),
        g: Math.round(lerp(lo.g, hi.g, t)),
        b: Math.round(lerp(lo.b, hi.b, t)),
        a: Math.round(lerp(lo.a, hi.a, t))
      }
    }
  }
  var last = stops[stops.length - 1]
  return { r: last.r, g: last.g, b: last.b, a: last.a }
}

function cssColorAt(mm) {
  var c = colorAt(mm)
  return "rgba(" + c.r + "," + c.g + "," + c.b + "," + (c.a / 255).toFixed(3) + ")"
}

// Legend entries: one swatch per named intensity band, using the WMO-ish
// light/moderate/heavy/violent classification thresholds.
var legendBands = [
  { label: "Light", mm: 0.5 },
  { label: "Moderate", mm: 4 },
  { label: "Heavy", mm: 15 },
  { label: "Very heavy", mm: 30 },
  { label: "Extreme", mm: 60 }
]

if (typeof module !== "undefined") module.exports = {
  stops: stops,
  colorAt: colorAt,
  cssColorAt: cssColorAt,
  legendBands: legendBands
}
