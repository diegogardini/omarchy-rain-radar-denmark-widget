import QtQuick
import QtTest
import ".." as Rain
import "../MapModel.js" as MapModel
import "../ColorScale.js" as ColorScale

Item {
  width: 460; height: 280
  Rain.RadarMap {
    id: map
    anchors.fill: parent
  }
  SignalSpy { id: pickedSpy; target: map; signalName: "picked" }
  TestCase {
    name: "RadarMap"
    when: windowShown

    function test_rendersWithNoFrame() {
      map.frame = null
      wait(50)
      compare(map.isForecast, false)
    }

    function test_forecastFrameIsFlaggedAndRendersWithoutError() {
      var cols = 4, rows = 3
      var values = []
      for (var i = 0; i < cols * rows; i++) values.push(i % 2 === 0 ? 0 : 3.5)
      map.frame = {
        time: "2026-09-17T14:00:00Z",
        kind: "forecast",
        png: null,
        grid: { cols: cols, rows: rows, bounds: { west: 8, south: 54.3, east: 15.3, north: 58 }, values: values }
      }
      wait(50)
      compare(map.isForecast, true)
    }

    function test_observedFrameIsNotFlaggedAsForecast() {
      map.frame = { time: "2026-09-17T13:50:00Z", kind: "observed", png: null, grid: null }
      wait(50)
      compare(map.isForecast, false)
    }

    function test_gridOnlyCoveringPartOfTheMapIsPlacedByItsOwnBounds() {
      // A grid may cover just a sub-rectangle of the (larger) map, so cells
      // must land by the grid's own bounds, not the map's. One lit cell in a
      // 2x2 grid over denmarkBounds: its centre pixel should be
      // rain-coloured, and the (unlit) opposite cell's centre should not.
      var hb = MapModel.denmarkBounds
      map.frame = {
        time: "2026-09-19T21:00:00Z", kind: "forecast", png: null,
        grid: { cols: 2, rows: 2, bounds: hb, values: [0, 0, 0, 9] }
      }
      waitForRendering(map)
      wait(100)
      var img = grabImage(map)
      var cx = (hb.west + hb.east) / 2, cy = (hb.south + hb.north) / 2
      var lit = MapModel.project(cy - (hb.north - hb.south) / 4, cx + (hb.east - hb.west) / 4, map.width, map.height)
      var unlit = MapModel.project(cy + (hb.north - hb.south) / 4, cx - (hb.east - hb.west) / 4, map.width, map.height)
      // Darkest red value in a small patch, not a single pixel: a thin
      // coastline stroke can pass through any one sample point (the unlit
      // spot is on the Limfjord), but it can't fill a whole patch.
      function minRed(cx, cy) {
        var m = 1
        for (var dx = -3; dx <= 3; dx++)
          for (var dy = -3; dy <= 3; dy++)
            m = Math.min(m, img.pixel(Math.round(cx) + dx, Math.round(cy) + dy).r)
        return m
      }
      var litRed = minRed(lit.x, lit.y)
      var unlitRed = minRed(unlit.x, unlit.y)
      // 9 mm/h is yellow-green: high red channel everywhere in the cell (any
      // coastline over it is even brighter); the unlit cell stays dark.
      verify(litRed > 0.35, "lit cell should be rain-coloured, got r=" + litRed)
      verify(unlitRed < 0.25, "unlit cell should be dark, got r=" + unlitRed)
    }

    function test_observedPngPathsPreloadsOneImagePerDistinctPath() {
      // Paths need not exist on disk for this: it only checks that the pool
      // has exactly one Image delegate per distinct path (the fix for
      // observed frames rendering blank on first play, since loading was
      // previously on-demand and couldn't keep up with playback).
      map.observedPngPaths = ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"]
      wait(50)
      compare(map.imageForPath("/tmp/a.png") !== null, true)
      compare(map.imageForPath("/tmp/b.png") !== null, true)
      compare(map.imageForPath("/tmp/c.png") !== null, true)
      compare(map.imageForPath("/tmp/missing.png"), null)
    }
  
    function test_pinIsDrawnWhereTheProjectionPutsIt() {
      map.frame = { time: "2026-09-20T10:00:00Z", kind: "observed", png: null, grid: null }
      map.pinColor = "#ff00ff"
      map.pin = { latitude: 55.6761, longitude: 12.5683 }
      waitForRendering(map)
      wait(50)
      var img = grabImage(map)
      var at = MapModel.project(55.6761, 12.5683, map.width, map.height)
      var c = img.pixel(Math.round(at.x), Math.round(at.y))
      verify(c.r > 0.9 && c.g < 0.1 && c.b > 0.9, "pin centre should be the pin colour, got " + c)
      // and not somewhere else, e.g. Aalborg
      var far = MapModel.project(57.0488, 9.9217, map.width, map.height)
      var f = img.pixel(Math.round(far.x), Math.round(far.y))
      verify(!(f.r > 0.9 && f.g < 0.1 && f.b > 0.9), "no pin colour away from the pin")
    }

    // An observed scan whose PNG is solid rain everywhere; its filled grid
    // sets every cell to `mm`. The fixed-echo cells must come from the grid.
    function observedOverSolidRain(mm) {
      var cols = 224, rows = 160, values = []
      for (var i = 0; i < cols * rows; i++) values.push(mm)
      var png = Qt.resolvedUrl("fixtures/solid-rain.png").toString().replace("file://", "")
      map.pin = null
      map.observedPngPaths = [png]
      map.frame = { time: "2026-10-03T12:00:00Z", kind: "observed", png: png, grid: null,
        observedGrid: { cols: cols, rows: rows, bounds: { west: 5.0, south: 53.9, east: 16.5, north: 58.5 }, values: values } }
      tryVerify(function() { var im = map.imageForPath(png); return im && im.status === Image.Ready }, 2000)
      waitForRendering(map)
      wait(50)
      return grabImage(map)
    }
    function isSolidRed(c) { return c.r > 0.9 && c.g < 0.1 && c.b < 0.1 }

    function test_fixedEchoCellsArePaintedFromTheFilledGrid() {
      // The middle of the Baltic wind-farm patch (row 128, col 175), at sea so no coastline crosses it
      var echo = MapModel.project(54.806, 14.010, map.width, map.height)
      var sea = MapModel.project(55.5, 7.0, map.width, map.height)
      var img = observedOverSolidRain(0)
      verify(isSolidRed(img.pixel(Math.round(sea.x), Math.round(sea.y))), "the PNG is drawn away from the echoes")
      verify(!isSolidRed(img.pixel(Math.round(echo.x), Math.round(echo.y))), "a dry filled cell hides the PNG's echo")

      img = observedOverSolidRain(5)
      var c = img.pixel(Math.round(echo.x), Math.round(echo.y))
      // 5 mm/h is green on the scale (ColorScale.cssColorAt(5), drawn translucent over the map)
      compare(ColorScale.cssColorAt(5).indexOf("rgba(105,201,70"), 0)
      verify(c.g > 0.5 && c.g > c.r + 0.2 && c.g > c.b + 0.2, "a wet filled cell is drawn in its own colour, got " + c)
    }

    // Forecast rain carried in from beyond the map's edge is hatched in the
    // foreground colour (greyish), not drawn in the rain palette.
    function test_rainFromBeyondTheEdgeIsHatchedNotColoured() {
      var cols = 40, rows = 20, values = [], fromEdge = []
      for (var i = 0; i < cols * rows; i++) { values.push(20); fromEdge.push(i % cols < cols / 2 ? 1 : 0) }
      map.pin = null
      map.foreground = "#e2e8f0"
      map.frame = { time: "2026-10-03T21:00:00Z", kind: "forecast", png: null,
        grid: { cols: cols, rows: rows, bounds: { west: 5.0, south: 53.9, east: 16.5, north: 58.5 }, values: values, fromEdge: fromEdge } }
      waitForRendering(map)
      wait(50)
      var img = grabImage(map)
      // sample a 12 x 12 patch in each half, away from coastlines (North Sea, and the Baltic east of Bornholm)
      function patch(lat, lon) {
        var p = MapModel.project(lat, lon, map.width, map.height), px = []
        for (var dx = -6; dx < 6; dx++) for (var dy = -6; dy < 6; dy++) px.push(img.pixel(Math.round(p.x) + dx, Math.round(p.y) + dy))
        return px
      }
      var sat = function(c) { return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) }
      var guessed = patch(56.5, 6.5), measured = patch(55.0, 16.0)
      verify(guessed.every(function(c) { return sat(c) < 0.12 }), "no rain-palette colour in the hatched half")
      verify(guessed.some(function(c) { return c.r > 0.35 }) && guessed.some(function(c) { return c.r < 0.2 }),
        "the hatched half has light lines and dark gaps")
      verify(measured.some(function(c) { return sat(c) > 0.3 }), "the other half is in the rain palette")
    }

    // Between nowcast steps the rain layer moves by the fraction of the
    // motion; nothing is repainted.
    function test_aNowcastFractionMovesTheRainAlongTheMotion() {
      var cols = 40, rows = 20, values = []
      for (var i = 0; i < cols * rows; i++) values.push(0)
      values[10 * cols + 10] = 20                     // one heavy cell
      map.pin = null
      map.fraction = 0
      map.frame = { time: "2026-10-03T21:00:00Z", kind: "forecast", png: null,
        grid: { cols: cols, rows: rows, bounds: { west: 5.0, south: 53.9, east: 16.5, north: 58.5 }, values: values },
        motion: { dx: 8, dy: 0 } }
      waitForRendering(map)
      wait(50)
      var cell = function(c) { return MapModel.project(58.5 - 10.5 * 4.6 / rows, 5.0 + (c + 0.5) * 11.5 / cols, map.width, map.height) }
      var sat = function(p) { var c = img.pixel(Math.round(p.x), Math.round(p.y)); return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) }
      var img = grabImage(map)
      verify(sat(cell(10)) > 0.3 && sat(cell(14)) < 0.1, "at fraction 0 the cell is in place")
      map.fraction = 0.5                              // half of 8 cells: 4 cells east
      waitForRendering(map)
      wait(50)
      img = grabImage(map)
      verify(sat(cell(14)) > 0.3 && sat(cell(10)) < 0.1, "at fraction 0.5 it has moved 4 cells east")
      map.fraction = 0
    }

    // The loop's nowcast frames are painted once each, ahead: switching to
    // one shows its own canvas (moved by the fraction too), and the shared
    // rain layer draws nothing over it.
    function test_loopNowcastFramesArePaintedAheadAndShownOnTheirTurn() {
      var cols = 40, rows = 20
      var grid = function(col) {
        var values = []
        for (var i = 0; i < cols * rows; i++) values.push(0)
        values[10 * cols + col] = 20
        return { cols: cols, rows: rows, bounds: { west: 5.0, south: 53.9, east: 16.5, north: 58.5 }, values: values }
      }
      var frames = [10, 20].map(function(col) {
        return { time: "2026-10-03T21:00:00Z", kind: "forecast", png: null, grid: grid(col), motion: { dx: 8, dy: 0 } }
      })
      map.pin = null
      map.fraction = 0
      map.forecastFrames = frames
      map.frame = frames[0]
      waitForRendering(map)
      wait(50)
      verify(map.frameCached)
      var cell = function(c) { return MapModel.project(58.5 - 10.5 * 4.6 / rows, 5.0 + (c + 0.5) * 11.5 / cols, map.width, map.height) }
      var sat = function(p) { var c = img.pixel(Math.round(p.x), Math.round(p.y)); return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) }
      var img = grabImage(map)
      verify(sat(cell(10)) > 0.3 && sat(cell(20)) < 0.1, "the first frame only")
      map.frame = frames[1]
      waitForRendering(map)
      wait(50)
      img = grabImage(map)
      verify(sat(cell(20)) > 0.3 && sat(cell(10)) < 0.1, "the second frame only")
      map.fraction = 0.5
      waitForRendering(map)
      wait(50)
      img = grabImage(map)
      verify(sat(cell(24)) > 0.3 && sat(cell(20)) < 0.1, "moved 4 cells east at fraction 0.5")
      map.fraction = 0
      map.forecastFrames = []
    }

    function test_noPinDrawsNoMarker() {
      map.pin = null
      waitForRendering(map)
      wait(50)
      var img = grabImage(map)
      var at = MapModel.project(55.6761, 12.5683, map.width, map.height)
      var c = img.pixel(Math.round(at.x), Math.round(at.y))
      verify(!(c.r > 0.9 && c.g < 0.1 && c.b > 0.9), "no marker without a pin")
    }

    function test_clickingTheMapReportsTheLocationUnderTheCursor() {
      pickedSpy.clear()
      var at = MapModel.project(56.1629, 10.2039, map.width, map.height) // Aarhus
      mouseClick(map, at.x, at.y)
      compare(pickedSpy.count, 1)
      var lat = pickedSpy.signalArguments[0][0], lon = pickedSpy.signalArguments[0][1]
      verify(Math.abs(lat - 56.1629) < 0.02 && Math.abs(lon - 10.2039) < 0.03, "picked " + lat + ", " + lon)
    }

    function test_clickingOutsideTheMapWindowPicksNothing() {
      pickedSpy.clear()
      mouseClick(map, 1, 1) // in the margin, north-west of the window
      compare(pickedSpy.count, 0)
    }
}
}
