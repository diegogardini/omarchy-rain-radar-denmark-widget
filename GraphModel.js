// A fixed, bounded scale with a gentler, almost linear response near zero.
// 1 mm/h is one third up, 2.5 mm/h is 56%, and 10 mm/h is 83%.
// The 2 mm/h knee compresses heavy showers without amplifying tiny changes.
function heightFraction(mm) {
  var value = Number(mm)
  if (!isFinite(value) || value <= 0) return 0
  return value / (2 + value)
}

function yFor(mm, top, bottom) {
  return bottom - heightFraction(mm) * (bottom - top)
}

// Shape-preserving cubic tangents. Harmonic means and the segment limiter
// prevent ringing at dry intervals or overshooting an isolated shower peak.
function tangents(points) {
  if (points.length < 2) return [0]
  var slopes = [], result = []
  for (var i = 0; i < points.length - 1; i++)
    slopes.push((points[i + 1].y - points[i].y) / (points[i + 1].x - points[i].x))
  result[0] = slopes[0]
  for (i = 1; i < points.length - 1; i++) {
    var a = slopes[i - 1], b = slopes[i]
    result[i] = a * b <= 0 ? 0 : 2 * a * b / (a + b)
  }
  result[points.length - 1] = slopes[slopes.length - 1]
  for (i = 0; i < slopes.length; i++) {
    if (slopes[i] === 0) { result[i] = 0; result[i + 1] = 0; continue }
    var alpha = result[i] / slopes[i], beta = result[i + 1] / slopes[i]
    var magnitude = alpha * alpha + beta * beta
    if (magnitude > 9) {
      var factor = 3 / Math.sqrt(magnitude)
      result[i] = factor * alpha * slopes[i]
      result[i + 1] = factor * beta * slopes[i]
    }
  }
  return result
}

// The chance steps from `nowMs` on: steps before it are dropped, and a point
// at `nowMs` itself is interpolated between its neighbours. The newest scan
// is 10-25 minutes behind the clock, so the first nowcast steps are already
// past, and a chance for a moment that has passed means nothing at the pin.
function chanceFromNow(steps, nowMs) {
  if (!steps || !steps.length || typeof nowMs !== "number") return steps || []
  var out = []
  for (var i = 0; i < steps.length; i++) {
    var s = steps[i]
    if (s.ms < nowMs) continue
    var prev = steps[i - 1]
    if (!out.length && s.ms > nowMs && prev && prev.ms < nowMs) {
      var t = (nowMs - prev.ms) / (s.ms - prev.ms)
      out.push({ ms: nowMs, minutes: 0, chance: prev.chance + t * (s.chance - prev.chance) })
    }
    out.push(s)
  }
  return out
}

// Opacity of a chance-strip cell: 0 for no chance, 1 for certain. The square
// root lifts the low end, so a 20-30% chance is plainly visible (0.5-0.6)
// rather than a faint tint, while the order of any two chances is kept.
function stripAlpha(chance) {
  var c = Math.max(0, Math.min(1, Number(chance) || 0))
  return c <= 0 ? 0 : 0.12 + 0.88 * Math.sqrt(c)
}

if (typeof module !== "undefined") module.exports = { heightFraction: heightFraction, yFor: yFor, tangents: tangents, chanceFromNow: chanceFromNow, stripAlpha: stripAlpha }
