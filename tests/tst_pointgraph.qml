import QtQuick
import QtTest
import ".." as Rain
import "../GraphModel.js" as GraphModel

Item {
  width: 460; height: 170
  Rain.PointGraph {
    id: graph
    anchors.fill: parent
    foreground: "#ffffff"
    accent: "#ff0000"
  }
  SignalSpy { id: seekSpy; target: graph; signalName: "seek" }

  TestCase {
    name: "PointGraph"
    when: windowShown

    property real t0: Date.parse("2026-09-20T10:00:00Z")

    function seriesWith(observedMm, nowcastMm) {
      var points = []
      for (var i = -12; i <= 0; i++) points.push({ ms: t0 + i * 300000, mm: observedMm, kind: "observed" })
      for (var k = 1; k <= 24; k++) points.push({ ms: t0 + k * 300000, mm: nowcastMm, kind: "nowcast" })
      return { points: points, nowMs: t0 }
    }

    // Any pixel in a small patch close to the accent colour.
    function hasAccent(img, cx, cy) {
      for (var dx = -3; dx <= 3; dx++)
        for (var dy = -3; dy <= 3; dy++) {
          var c = img.pixel(Math.round(cx) + dx, Math.round(cy) + dy)
          if (c.r > 0.85 && c.g < 0.25 && c.b < 0.25) return true
        }
      return false
    }

    function test_emptySeriesDrawsOnlyTheScale() {
      graph.series = { points: [], nowMs: null }
      wait(50)
      compare(graph.windowStart, 0)
    }

    function test_timeAxisIsProportionalToRealTime() {
      graph.series = seriesWith(1, 1)
      compare(graph.windowStart, t0 - 3600000)
      compare(graph.windowEnd, t0 + 5400000)
      // "now" is 40% of the way across (1 h past, 90 min ahead)
      var frac = (graph.xFor(t0) - graph.plotLeft) / (graph.plotRight - graph.plotLeft)
      verify(Math.abs(frac - 0.4) < 1e-9, "now at " + frac)
      // xFor and msFor are inverses
      verify(Math.abs(graph.msFor(graph.xFor(t0 + 1234567)) - (t0 + 1234567)) < 1)
    }

    function test_observedRainIsDrawnAtItsHeight() {
      graph.series = seriesWith(10, 10)
      graph.cursorMs = -1
      waitForRendering(graph)
      wait(100)
      var img = grabImage(graph)
      var y = GraphModel.yFor(10, graph.plotTop, graph.plotBottom)
      // in the middle of the observed half, and the nowcast half
      verify(hasAccent(img, graph.xFor(t0 - 1800000), y), "observed line at 10 mm/h")
      verify(hasAccent(img, graph.xFor(t0 + 3600000 + 20000), y) || hasAccent(img, graph.xFor(t0 + 3600000 + 90000), y), "nowcast line at 10 mm/h")
      // and not at a different height
      var yLow = GraphModel.yFor(0.1, graph.plotTop, graph.plotBottom)
      verify(!hasAccent(img, graph.xFor(t0 - 1800000), yLow), "no line down at 0.1 mm/h")
    }

    function test_clickingSeeksToTheTimeUnderTheCursor() {
      graph.series = seriesWith(1, 1)
      seekSpy.clear()
      mouseClick(graph, graph.xFor(t0 + 3600000), 60)
      compare(seekSpy.count, 1)
      verify(Math.abs(seekSpy.signalArguments[0][0] - (t0 + 3600000)) < 60000, "sought " + seekSpy.signalArguments[0][0])
    }

    function test_clickingTheLabelColumnDoesNotSeek() {
      seekSpy.clear()
      mouseClick(graph, graph.width - 5, 60)
      compare(seekSpy.count, 0)
    }

    function test_noSeekWithoutData() {
      graph.series = { points: [], nowMs: null }
      seekSpy.clear()
      mouseClick(graph, 100, 60)
      compare(seekSpy.count, 0)
    }
  }
}
