import QtQuick
import "GraphModel.js" as GraphModel
import "Timeline.js" as Timeline

// Rain rate (mm/h) at one location over a real time axis: the last hour
// observed (solid) and the radar nowcast (finely dashed, lighter). Under the
// time axis, from "now" on, a strip shaded by the chance of rain. A marker
// shows "now"; a second one follows the map's playback and can be
// dragged/clicked to seek.
//
// Deliberately free of qs.Commons so it can be tested on its own — the owner
// passes the theme colours and font in.
Canvas {
  id: graph

  // PointSeries.build() result: {points: [{ms, mm, kind}], nowMs}
  property var series: ({ points: [], nowMs: null })
  // Time of the map's current frame (ms since epoch), or -1 for none.
  property real cursorMs: -1
  // Chance of rain at each nowcast step, [{ms, chance}] with chance 0..1, drawn
  // as a strip under the time axis: each step's cell shaded by its chance, in
  // a warm colour. A second line on its own 0-100% scale was hard to follow.
  property var chance: []
  property color chanceColor: "#f6b756"
  property color foreground: "#e2e8f0"
  property color accent: "#7dd3fc"
  property string fontFamily: "sans-serif"
  property real fontSize: 10

  signal seek(real ms)

  readonly property real pastMs: 60 * 60000
  readonly property real aheadMs: 90 * 60000 // PointSeries.HORIZON_MINUTES: the pin looks 90 min past the clock
  readonly property var levels: [
    { value: 0, label: "" }, // baseline; a "0" label would collide with "0.1" just above it
    { value: 0.1, label: "0.1" },
    { value: 1.0, label: "1" },
    { value: 2.5, label: "2.5" },
    { value: 10.0, label: "10" },
    { value: 50.0, label: "50" }
  ]

  // Small (the box over Sweden on the map): a shorter readout, no separate
  // unit title, a little more room at the top.
  readonly property bool compact: width < 260

  // Plot rectangle and time window, shared by painting and click mapping.
  readonly property real padLeft: 10
  // two rows above the plot: the cursor's reading, then the unit over the scale
  readonly property real padTop: compact ? 32 : 28
  readonly property real stripH: 9
  readonly property real padBottom: 24 + stripH + 4
  readonly property real padRight: 30
  readonly property real plotLeft: padLeft
  readonly property real plotRight: width - padRight
  readonly property real plotTop: padTop
  readonly property real plotBottom: height - padBottom
  readonly property real windowStart: series.nowMs === null ? 0 : series.nowMs - pastMs
  readonly property real windowEnd: series.nowMs === null ? 1 : series.nowMs + aheadMs

  function xFor(ms) {
    return plotLeft + (ms - windowStart) / (windowEnd - windowStart) * (plotRight - plotLeft)
  }
  function msFor(x) {
    return windowStart + (x - plotLeft) / (plotRight - plotLeft) * (windowEnd - windowStart)
  }
  function clock(ms) {
    var d = new Date(ms)
    return (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes()
  }
  function alpha(color, a) { return Qt.rgba(color.r, color.g, color.b, a) }

  function traceCurve(ctx, pts, tangents, from, to) {
    ctx.moveTo(pts[from].x, pts[from].y)
    for (var i = from; i < to; i++) {
      var dx = pts[i + 1].x - pts[i].x
      ctx.bezierCurveTo(pts[i].x + dx / 3, pts[i].y + tangents[i] * dx / 3,
                        pts[i + 1].x - dx / 3, pts[i + 1].y - tangents[i + 1] * dx / 3,
                        pts[i + 1].x, pts[i + 1].y)
    }
  }

  // Filled area under pts[from..to].
  function fillUnder(ctx, pts, tangents, from, to, topColor, bottomColor) {
    var fill = ctx.createLinearGradient(0, plotTop, 0, plotBottom)
    fill.addColorStop(0, topColor)
    fill.addColorStop(1, bottomColor)
    ctx.fillStyle = fill
    ctx.beginPath()
    traceCurve(ctx, pts, tangents, from, to)
    ctx.lineTo(pts[to].x, plotBottom)
    ctx.lineTo(pts[from].x, plotBottom)
    ctx.closePath()
    ctx.fill()
  }

  function strokeSegment(ctx, pts, tangents, from, to, dash, color, lineWidth) {
    ctx.setLineDash(dash)
    ctx.strokeStyle = color
    ctx.lineWidth = lineWidth
    ctx.beginPath()
    traceCurve(ctx, pts, tangents, from, to)
    ctx.stroke()
    ctx.setLineDash([])
  }

  onSeriesChanged: requestPaint()
  onChanceChanged: requestPaint()
  onCursorMsChanged: requestPaint()
  onWidthChanged: requestPaint()
  onHeightChanged: requestPaint()
  onForegroundChanged: requestPaint()
  onAccentChanged: requestPaint()

  onPaint: {
    var ctx = getContext("2d")
    ctx.reset()
    if (plotRight <= plotLeft || plotBottom <= plotTop) return

    ctx.font = fontSize + "px " + fontFamily
    ctx.textBaseline = "middle"

    // Level lines with their labels on the right.
    ctx.textAlign = "left"
    for (var l = 0; l < levels.length; l++) {
      var y = GraphModel.yFor(levels[l].value, plotTop, plotBottom)
      ctx.strokeStyle = alpha(foreground, levels[l].value === 0 ? 0.35 : 0.12)
      ctx.lineWidth = 1
      ctx.setLineDash(levels[l].value === 0 ? [] : [3, 5])
      ctx.beginPath()
      ctx.moveTo(plotLeft, y)
      ctx.lineTo(plotRight, y)
      ctx.stroke()
      ctx.fillStyle = alpha(foreground, 0.55)
      ctx.fillText(levels[l].label, plotRight + 6, y)
    }
    ctx.setLineDash([])
    ctx.fillStyle = alpha(foreground, 0.55)
    ctx.textAlign = "left"
    // the unit over the rain scale, in the scale's own colour
    ctx.fillStyle = alpha(foreground, 0.55)
    ctx.fillText("mm/h", plotRight + 2, plotTop - 8)

    var pts = series.points
    if (!pts || pts.length === 0 || series.nowMs === null) return

    // Time axis: the hour marks inside the window, and "now"; an hour mark
    // that would overlap the "now" label is left out.
    ctx.textBaseline = "top"
    ctx.textAlign = "center"
    ctx.fillStyle = alpha(foreground, 0.55)
    var nowLabelX = xFor(series.nowMs)
    if (compact) {
      // too narrow for clock times, and what matters is ahead: minutes from now
      for (var m = 30; m * 60000 <= aheadMs; m += 30) ctx.fillText(m + "m", xFor(series.nowMs + m * 60000), plotBottom + stripH + 12)
    } else {
      var firstHour = Math.ceil(windowStart / 3600000) * 3600000
      for (var h = firstHour; h <= windowEnd; h += 3600000) {
        var hx = xFor(h)
        var room = (ctx.measureText(clock(h)).width + ctx.measureText("now").width) / 2 + 4
        if (Math.abs(hx - nowLabelX) < room) continue
        if (hx < plotLeft + 14 || hx > plotRight - 14) continue
        ctx.fillText(clock(h), hx, plotBottom + stripH + 12)
      }
    }

    var xy = []
    for (var i = 0; i < pts.length; i++) xy.push({ x: xFor(pts[i].ms), y: GraphModel.yFor(pts[i].mm, plotTop, plotBottom) })
    var tangents = GraphModel.tangents(xy)

    // Index ranges of each kind; the segments share their join point so the
    // line is continuous (a segment starts at the previous one's last point).
    var lastObserved = -1, lastNowcast = -1, firstNowcast = -1
    for (i = 0; i < pts.length; i++) {
      if (pts[i].kind === "observed") lastObserved = i
      else if (pts[i].kind === "nowcast") { lastNowcast = i; if (firstNowcast < 0) firstNowcast = i }
    }

    var topA = alpha(accent, 0.42), botA = alpha(accent, 0.10)
    var topB = alpha(accent, 0.20), botB = alpha(accent, 0.05)
    if (lastObserved >= 1) {
      fillUnder(ctx, xy, tangents, 0, lastObserved, topA, botA)
    }
    if (firstNowcast >= 0) {
      var from = Math.max(0, firstNowcast - 1)
      fillUnder(ctx, xy, tangents, from, lastNowcast, topB, botB)
    }
    ctx.lineJoin = "round"
    ctx.lineCap = "round"
    if (lastObserved >= 1) strokeSegment(ctx, xy, tangents, 0, lastObserved, [], accent, 2)
    // finely dashed, as the map's Denmark outline during the nowcast (RadarMap.nowcastDash)
    if (firstNowcast >= 0) strokeSegment(ctx, xy, tangents, Math.max(0, firstNowcast - 1), lastNowcast, [1.5, 2.5], alpha(accent, 0.85), 2)

    // Chance of rain: a strip under the axis from "now" on, one cell per
    // nowcast step, shaded by its chance (GraphModel.stripAlpha).
    if (chance && chance.length > 0) {
      var sy = plotBottom + 3, sx = xFor(series.nowMs)
      var sc = GraphModel.chanceFromNow(chance, series.nowMs)
      ctx.fillStyle = alpha(foreground, 0.07)
      ctx.fillRect(sx, sy, plotRight - sx, stripH)
      for (i = 0; i < sc.length; i++) {
        var x0 = Math.max(sx, xFor(sc[i].ms - 5 * 60000)), x1 = Math.min(plotRight, xFor(sc[i].ms + 5 * 60000))
        if (x1 <= x0 || sc[i].chance <= 0) continue
        ctx.fillStyle = alpha(chanceColor, GraphModel.stripAlpha(sc[i].chance))
        ctx.fillRect(x0, sy, x1 - x0, stripH)
      }
      ctx.fillStyle = alpha(chanceColor, 0.9)
      ctx.textAlign = "right"
      ctx.textBaseline = "middle"
      // the label left of "now", shortened when the past hour is too narrow for it
      var stripLabel = ctx.measureText("chance of rain").width <= sx - plotLeft - 5 ? "chance of rain" : "chance"
      ctx.fillText(stripLabel, sx - 5, sy + stripH / 2)
    }

    // "now" marker.
    var nowX = xFor(series.nowMs)
    ctx.strokeStyle = alpha(foreground, 0.55)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(nowX, plotTop)
    ctx.lineTo(nowX, plotBottom)
    ctx.stroke()
    ctx.textAlign = "center"
    ctx.textBaseline = "top"
    ctx.fillStyle = alpha(foreground, 0.8)
    ctx.fillText("now", nowX, plotBottom + stripH + 12)

    // Playback cursor with its reading.
    if (cursorMs >= windowStart && cursorMs <= windowEnd) {
      var near = 0, gap = Infinity
      for (i = 0; i < pts.length; i++) {
        var g = Math.abs(pts[i].ms - cursorMs)
        if (g < gap) { gap = g; near = i }
      }
      var cx = xFor(cursorMs)
      ctx.strokeStyle = alpha(accent, 0.9)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(cx, plotTop)
      ctx.lineTo(cx, plotBottom)
      ctx.stroke()
      ctx.fillStyle = accent
      ctx.beginPath()
      ctx.arc(cx, xy[near].y, 3.5, 0, Math.PI * 2)
      ctx.fill()

      // The reading in parts, each in its line's colour: the time, the rain
      // (blue, as the rain line) and, ahead of now, the chance (amber, as the strip).
      var parts = [
        // the time to the nearest 10 minutes, as the map's badge (the cursor still glides)
        { text: clock(Timeline.shownMs(cursorMs)) + (compact ? " " : "  "), color: alpha(foreground, 0.9) },
        { text: pts[near].mm.toFixed(pts[near].mm < 10 ? 1 : 0) + " mm/h", color: accent }
      ]
      if (pts[near].kind === "nowcast" && pts[near].ms >= series.nowMs && chance && chance.length) {
        var cn = null, cg = Infinity
        for (i = 0; i < chance.length; i++) {
          var dg = Math.abs(chance[i].ms - pts[near].ms)
          if (dg < cg) { cg = dg; cn = chance[i] }
        }
        if (cn && cg < 6 * 60000) {
          parts.push({ text: compact ? " · " : "  ·  ", color: alpha(foreground, 0.5) })
          parts.push({ text: Math.round(cn.chance * 100) + (compact ? "%" : "% chance"), color: chanceColor })
        }
      }
      var w = 0
      for (i = 0; i < parts.length; i++) w += ctx.measureText(parts[i].text).width
      var lx = Math.max(plotLeft, Math.min(plotRight - w, cx - w / 2))
      ctx.textBaseline = "middle"
      ctx.textAlign = "left"
      for (i = 0; i < parts.length; i++) {
        ctx.fillStyle = parts[i].color
        ctx.fillText(parts[i].text, lx, plotTop - 22)
        lx += ctx.measureText(parts[i].text).width
      }
    }
  }

  MouseArea {
    anchors.fill: parent
    enabled: graph.series.nowMs !== null
    cursorShape: Qt.PointingHandCursor
    onClicked: function(mouse) {
      if (mouse.x >= graph.plotLeft && mouse.x <= graph.plotRight) graph.seek(graph.msFor(mouse.x))
    }
  }
}
