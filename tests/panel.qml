import QtQuick
import Quickshell
import qs.Commons
import "Plugin" as Rain
import "Plugin/MapModel.js" as MapModel
import "Plugin/Timeline.js" as Timeline
import "Plugin/Interpolation.js" as Interpolation

ShellRoot {
  id: test
  property int phase: 0
  property int ticks: 0
  property int startIndex: 0
  property var savedWeather: null
  function check(value, message) { if (!value) { console.error("FAIL: " + message); Qt.exit(1) } }
  Rain.Panel { id: panel }

  // 4x2 grid over the whole map: cell index = row*4 + col. Odense falls in
  // cell 5, Copenhagen in cell 6.
  function coarseGrid(odense, copenhagen, raw) {
    var values = [0, 0, 0, 0, 0, odense, copenhagen, 0]
    var grid = { cols: 4, rows: 2, bounds: MapModel.bounds, values: values }
    if (raw) grid.rawValues = values
    return grid
  }
  function injectScans() {
    var ds = panel.dataService
    var t0 = Date.now() - (Date.now() % 600000)
    function iso(ms) { return new Date(ms).toISOString().replace(".000Z", "Z") }
    var cols = 64, rows = 48, grids = {}, items = []
    for (var i = 0; i < 4; i++) {
      var v = []
      for (var r = 0; r < rows; r++)
        for (var c = 0; c < cols; c++)
          v.push(10 * Math.exp(-(Math.pow((c - 8 - i) / 4, 2) + Math.pow((r - 20) / 4, 2))))
      grids["s" + i] = { cols: cols, rows: rows, bounds: MapModel.bounds, values: v }
      items.push({ id: "s" + i, datetime: iso(t0 - (3 - i) * 600000), pngPath: "", nowcastGridPath: "" })
    }
    ds.radarNowcastKey = ""
    ds.observedGrids = grids
    ds.observedItems = items
  }
  function setUpPointData() {
    var ds = panel.dataService
    var t0 = Date.now() - (Date.now() % 1000)
    function iso(ms) { return new Date(ms).toISOString().replace(".000Z", "Z") }
    panel.clockMs = Date.now()
    var grids = {}
    var items = []
    for (var i = 0; i < 3; i++) {
      var id = "scan" + i
      grids[id] = coarseGrid(0.2 * (i + 1), 0, false) // 0.2, 0.4, 0.6 mm/h at Odense
      items.push({ id: id, datetime: iso(t0 - (2 - i) * 600000), pngPath: "", nowcastGridPath: "" })
    }
    var nowcast = []
    for (var k = 1; k <= 12; k++) nowcast.push({ time: iso(t0 + k * 600000), grid: coarseGrid(k === 3 ? 7.5 : 1, 3, true) })
    ds.observedGrids = grids
    ds.observedItems = items
    ds.radarNowcast = nowcast
    ds.gridsRevision++
  }
  function checkPointGraph() {
    var ds = panel.dataService
    // Omarchy Weather location "Aarhus" (name only) resolved through the city list.
    test.check(panel.pin !== null && panel.pin.name === "Aarhus" && panel.pin.source === "weather", "a name-only weather.json resolves to Aarhus: " + JSON.stringify(panel.pin))
    test.check(ds.radarNowcast.length === 12, "the injected nowcast has 12 steps")
    // Aarhus (56.16N 10.20E) is in cell 5 of the coarse grid too (row 1, col 1).
    var s = panel.pointSeries
    // the pin looks 90 min past the clock: 9 of the 12 steps
    test.check(s.points.length === 3 + 9, "3 observed + 9 nowcast points at the pin, got " + s.points.length)
    test.check(Math.abs(panel.pointNowMm - 0.6) < 0.01, "current value is the reading at the clock (the scan from seconds ago), got " + panel.pointNowMm)
    test.check(panel.barLabel.indexOf("0.6") >= 0, "bar label shows the pin value: " + panel.barLabel)
    test.check(panel.tooltip.indexOf("Aarhus") >= 0, "tooltip names the pin: " + panel.tooltip)
    var last = s.points[s.points.length - 1]
    test.check(Math.abs(last.ms - s.nowMs - 90 * 60000) < 60000, "the last nowcast point is 90 min after now")
    test.check(panel.dataAgeText.indexOf("Radar from ") === 0 && !panel.dataStale, "a fresh scan's age is shown and not stale: " + panel.dataAgeText)

    // A pin picked on the map wins over the weather location and is persisted.
    panel.setPin(55.6761, 12.5683)
    test.check(panel.pin.source === "pin" && panel.pin.name === "Copenhagen", "a pin near Copenhagen is named after it: " + JSON.stringify(panel.pin))
    test.check(panel.pointSeries.points.length === 12 && panel.pointSeries.points[0].mm === 0, "the pin series re-samples at the new place")
    // the value at the clock, seconds after a dry scan with 3 mm/h due in 10 min: barely above 0
    test.check(panel.barMm < 0.05 && panel.barLabel.indexOf("0.0") >= 0, "bar label follows the pin: " + panel.barLabel + " (" + panel.barMm + ")")
    panel.clearPin()
    test.check(panel.pin === null && !panel.usingLocation, "the ✕ leaves no place (it does not fall back to the weather location)")
    panel.setPin(55.4038, 10.4024, "Odense")
    var peak = 0
    for (var i = 0; i < panel.pointSeries.points.length; i++) peak = Math.max(peak, panel.pointSeries.points[i].mm)
    test.check(peak === 7.5, "the nowcast peak at Odense is read at step 3, got " + peak)
    test.check(panel.tooltip.indexOf("Light rain now · moderate rain in 30 min") >= 0, "tooltip reports the upcoming peak in words: " + panel.tooltip)
    checkRadarNowcastMotion()
  }
  // The real computeRadarNowcast (not an injected nowcast): four evenly spaced
  // scans of a shower drifting one cell per scan must give a 12-step nowcast
  // that keeps drifting at that speed, using all four scans for the motion.
  function checkRadarNowcastMotion() {
    var ds = panel.dataService
    var t0 = Date.now() - (Date.now() % 600000)
    function iso(ms) { return new Date(ms).toISOString().replace(".000Z", "Z") }
    var cols = 64, rows = 48
    function shower(cx) {
      var v = []
      for (var r = 0; r < rows; r++)
        for (var c = 0; c < cols; c++)
          v.push(10 * Math.exp(-(Math.pow((c - cx) / 4, 2) + Math.pow((r - 20) / 4, 2))))
      return { cols: cols, rows: rows, bounds: MapModel.bounds, values: v }
    }
    var grids = {}
    var items = []
    for (var i = 0; i < 4; i++) {
      grids["m" + i] = shower(8 + i)
      items.push({ id: "m" + i, datetime: iso(t0 - (3 - i) * 600000), pngPath: "", nowcastGridPath: "" })
    }
    ds.radarNowcastKey = ""
    ds.observedGrids = grids
    ds.observedItems = items
    ds.computeRadarNowcast()
    var n = Timeline.nowcastSteps(10, (Date.now() - (t0)) / 60000, 90, 150)
    test.check(ds.radarNowcast.length === n, "the nowcast reaches 90 min past the clock: " + n + " steps, got " + ds.radarNowcast.length)
    test.check(ds.radarNowcastKey === "m0|m1|m2|m3#" + n, "all four scans feed the motion estimate: " + ds.radarNowcastKey)
    // each pair's vector is kept; the mean is exactly the whole-map vector over the four scans
    var keys = Object.keys(ds.pairVectors).filter(function(k) { return k.charAt(0) === "m" })
    test.check(keys.length === 3, "three pair vectors kept: " + keys)
    var whole = Interpolation.globalMotionFromFrames([grids.m0, grids.m1, grids.m2, grids.m3], 8, 6)
    var mean = Interpolation.meanMotion(["m0|m1", "m1|m2", "m2|m3"].map(function(k) { return ds.pairVectors[k] || null }))
    test.check(Math.abs(mean.dx - whole.dx) < 1e-12 && Math.abs(mean.dy - whole.dy) < 1e-12, "the kept pairs give the whole-map vector")
    // a fifth scan adds one pair; the other two are reused as they are, and pruning drops the oldest
    var kept = ds.pairVectors["m2|m3"]
    grids["m4"] = shower(12)
    items.push({ id: "m4", datetime: iso(t0 + 600000), pngPath: "", nowcastGridPath: "" })
    ds.observedGrids = grids
    ds.observedItems = items.slice(1)
    ds.pruneObservedGrids()
    ds.radarNowcastKey = ""
    ds.computeRadarNowcast()
    test.check(ds.pairVectors["m2|m3"] === kept && ds.pairVectors["m3|m4"] !== undefined && ds.pairVectors["m0|m1"] === undefined,
      "a new scan computes only its own pair: " + Object.keys(ds.pairVectors))
    ds.observedItems = items.slice(0, 4)
    ds.observedGrids = { m0: grids.m0, m1: grids.m1, m2: grids.m2, m3: grids.m3 }
    ds.radarNowcastKey = ""
    ds.computeRadarNowcast()
    // rawValues: the predicted rain (the same as the drawn values: nothing is faded)
    var last = ds.radarNowcast[n - 1].grid.rawValues
    var best = -1, at = 0
    for (var k = 0; k < last.length; k++) if (last[k] > best) { best = last[k]; at = k }
    var col = at % cols
    test.check(Math.abs(col - (11 + n)) <= 2, "the shower keeps drifting one cell per step: column " + col + ", expected " + (11 + n))
    test.check(best > 8, "the prediction keeps the shower's intensity, peak " + best)
    // a scan that never loaded ends the run there; two usable scans still give a nowcast
    ds.observedGrids["m1"] = false
    ds.computeRadarNowcast()
    test.check(ds.radarNowcastKey === "m2|m3#" + n && ds.radarNowcast.length === n, "a missing scan shortens the run: " + ds.radarNowcastKey)
    // an hour-old newest scan is flagged stale, in the panel and the tooltip
    var old = Date.now() - 60 * 60000
    ds.observedItems = [{ id: "old", datetime: new Date(old).toISOString(), pngPath: "", nowcastGridPath: "" }]
    panel.clockMs = Date.now()
    test.check(panel.dataStale && panel.dataAgeMin === 60, "an hour-old scan is stale: " + panel.dataAgeMin)
    test.check(panel.dataAgeText.indexOf("DMI may be delayed") > 0 && panel.tooltip.indexOf("radar 1 h old") > 0, "stale data is said plainly: " + panel.dataAgeText + " | " + panel.tooltip)
    // town search: type part of a name, take the first match, and the pin goes there
    panel.choosingPlace = true
    panel.searchingTown = true
    panel.townQuery = "skærb"
    test.check(panel.townMatches.length === 5 && panel.townMatches[0].label === "Skærbæk, near Ribe", "town search ranks the South Jutland Skærbæk first: " + JSON.stringify(panel.townMatches[0]))
    panel.pickTown(panel.townMatches[0])
    test.check(panel.pin.name === "Skærbæk" && Math.abs(panel.pin.latitude - 55.157) < 0.01 && !panel.searchingTown && !panel.choosingPlace && panel.townQuery === "",
      "picking a match pins it and closes the search: " + JSON.stringify(panel.pin))
    panel.setPin(55.4038, 10.4024, "Odense")
    // the map picks only Denmark: a click in Malmö is ignored, one in Odense pins it
    test.check(panel.pickOnMap(55.60, 13.00) === false && panel.pin.name === "Odense", "a click in Sweden picks nothing")
    test.check(panel.pickOnMap(55.40, 10.39) === true && panel.pin.source === "pin", "a click in Denmark pins it")
    // "Use location" with an Omarchy weather location (Aarhus here) follows it; off again keeps it as a pin
    panel.toggleUseLocation()
    test.check(panel.usingLocation && panel.pin.name === "Aarhus" && panel.pin.source === "weather", "Use location follows the weather location: " + JSON.stringify(panel.pin))
    panel.toggleUseLocation()
    test.check(!panel.usingLocation && panel.pin.name === "Aarhus" && panel.pin.source === "pin", "turning it off keeps the place as a pin: " + JSON.stringify(panel.pin))
    // "Change place" while following: following stops, no place, the chips open with nothing selected
    panel.toggleUseLocation()
    test.check(panel.usingLocation, "following again")
    panel.changePlace()
    test.check(!panel.usingLocation && panel.pin === null && panel.choosingPlace, "Change place while following stops it and opens the chips: " + JSON.stringify(panel.pin))
    // and that "no place" survives a reload of the saved file
    panel.selectionLoaded('{"noPlace": true}\n')
    test.check(panel.pin === null && panel.noPlace, "no place is remembered")
    // without a weather location it detects one (wttr.in); checked in phase 6, after the (stubbed, failing) curl
    test.savedWeather = panel.weatherLocation
    panel.weatherLocation = null
    panel.toggleUseLocation()
    test.check(panel.usingLocation && panel.followLocation, "Use location without a weather location follows the detected one")
  }
  Timer {
    interval: 100
    running: true
    repeat: true
    onTriggered: {
      test.ticks++
      if (test.ticks > 250) { console.error("Timeout phase " + test.phase); Qt.exit(1); return }

      if (test.phase === 0 && !panel.dataService.loading && panel.dataService.gdalStatus !== "unknown") {
        // The stubbed radar API lists no scans: nothing to show, and the panel says why.
        test.check(panel.dataService.frames.length === 0, "no scans means no frames")
        test.check(panel.dataService.errorMessage !== "", "no scans gives an error message")
        // Four 10-minute scans of a drifting shower, injected as if converted.
        test.injectScans()
        panel.dataService.buildTimeline()
        test.phase = 1
        test.ticks = 0
      } else if (test.phase === 1 && panel.dataService.frames.length > 0) {
        var ds = panel.dataService
        var expected = Timeline.nowcastSteps(10, (Date.now() - Date.parse(ds.observedItems[3].datetime)) / 60000, 90, 150)
        test.check(ds.frames.length === 4 + expected, "4 observed + " + expected + " nowcast frames, got " + ds.frames.length)
        test.check(ds.nowIndex === 4, "the loop's 'now' is the first nowcast frame, got " + ds.nowIndex)
        test.check(ds.frames[0].kind === "observed" && ds.frames[4].kind === "forecast", "observed frames come first, then the nowcast")
        test.check(ds.frames[4].grid && ds.frames[4].grid.fromEdge, "nowcast frames carry the edge-guess marks")
        test.check(ds.errorMessage === "", "a built timeline clears the error")
        panel.open()
        test.phase = 3
        test.ticks = 0
      } else if (test.phase === 3 && test.ticks > 5) {
        test.startIndex = panel.playback.index
        test.phase = 4
        test.ticks = 0
      } else if (test.phase === 4 && test.ticks > 8) {
        test.check(panel.playback.index !== test.startIndex || panel.playback.frames.length === 1, "playback advances while playing")
        test.setUpPointData()
        test.phase = 5
        test.ticks = 0
      } else if (test.phase === 5 && test.ticks > 3) {
        test.checkPointGraph()
        test.phase = 6
        test.ticks = 0
      } else if (test.phase === 6 && test.ticks > 3) {
        // the stubbed curl answers nothing for wttr.in, so the detection failed, and says so
        test.check(panel.locationStatus.indexOf("Could not find your location") === 0 && panel.pin === null, "a failed detection says so: " + panel.locationStatus)
        panel.weatherLocation = test.savedWeather
        // two pins in quick succession (Skærbæk, then Odense): the second must hold, even when the
        // first save's reload arrives late (fed in directly, as the file watcher can deliver it)
        panel.setPin(55.157, 8.7657, "Skærbæk")
        panel.setPin(55.4038, 10.4024, "Odense")
        panel.selectionLoaded(panel.ownWrites[panel.ownWrites.length - 2])
        test.check(panel.pin.name === "Odense", "a late reload of the first save does not undo the second pin: " + JSON.stringify(panel.pin))
        // back to fresh point data, so the closing screenshot shows the whole panel with its graph
        test.setUpPointData()
        test.phase = 7
        test.ticks = 0
      } else if (test.phase === 7 && test.ticks > 3) {
        // the pin file's reloads have settled: the last place set (Odense, just after Skærbæk) holds
        test.check(panel.pin && panel.pin.name === "Odense", "a quick second pin is not undone by the first save's reload: " + JSON.stringify(panel.pin))
        for (var i = 0; i < panel.data.length; i++) {
          var child = panel.data[i]
          if (child.contentWidth !== undefined && child.contentItem) {
            child.contentItem[0].grabToImage(function(result) {
              if (Quickshell.env("RAIN_RADAR_TEST_CAPTURE")) test.check(result.saveToFile(Quickshell.env("RAIN_RADAR_TEST_CAPTURE")), "save screenshot")
              console.log("PASS: empty radar API handled, injected scans build observed + nowcast frames, panel opens, playback advances, pin graph reads the pin, nowcast motion, full render")
              Qt.quit()
            })
            return
          }
        }
        console.error("Popup not found")
        Qt.exit(1)
      }
    }
  }
}
