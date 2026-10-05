import QtQuick
import QtQml
import Quickshell
import Quickshell.Io
import "RadarModel.js" as RadarModel
import "Interpolation.js" as Interpolation
import "MapModel.js" as MapModel
import "FixedEchoes.js" as FixedEchoes
import "Timeline.js" as Timeline
import "PointSeries.js" as PointSeries

// Owns every Process/FileView used to fetch, cache and convert DMI's radar
// scans and to build the observed + nowcast animation loop.
// Non-visual — Panel.qml instantiates this and binds to its properties.
Item {
  id: root

  property int refreshMinutes: 10
  readonly property string pluginDir: String(Qt.resolvedUrl(".")).replace("file://", "")
  readonly property string helperScript: pluginDir + "helpers/dmi-radar-to-png"
  readonly property string cacheRoot: (Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")) + "/omarchy/cache/rain-radar-denmark"
  readonly property string framesDir: cacheRoot + "/frames"
  readonly property string rawDir: cacheRoot + "/raw"

  // "unknown" while the check hasn't run yet, then "available" or "missing".
  property string gdalStatus: "unknown"
  property bool loading: false
  property string errorMessage: ""

  // The radar nowcast: steps at the scan cadence (10 min) far enough to reach
  // 90 min past the clock (Timeline.nowcastSteps), each with its real
  // timestamp — [{time, grid}]. Kept apart from `frames` because the graph
  // reads it directly. Rebuilt whenever a new scan arrives.
  property var radarNowcast: []
  property string radarNowcastKey: ""
  // The nowcast's motion, grid cells per step ({dx, dy}): the map moves each
  // step's picture by a fraction of it between steps (smooth nowcast).
  property var radarNowcastMotion: ({ dx: 0, dy: 0 })
  // Whether any nowcast step shows rain guessed from beyond the map's edge
  // (hatched); the legend explains the hatching only then.
  property bool radarNowcastHasEdgeGuess: false
  // Observed nowcast-resolution grids, by scan id (false = unreadable), kept
  // in memory so the point graph can be re-sampled instantly when the pin
  // moves. `gridsRevision` bumps whenever either this or radarNowcast changes,
  // since mutating the object in place raises no change signal.
  property var observedGrids: ({})
  readonly property int motionScans: 4 // full-range scans (30 min) used to estimate the nowcast's motion
  readonly property int observedScans: 7 // full-range scans kept for the observed animation (one hour)
  readonly property int maxLeadMinutes: 150 // the nowcast never runs further than this after its scan
  property int gridsRevision: 0
  // Each scan pair's whole-map vector ({dx, dy}, or false where nothing could
  // be measured), by "idA|idB". Block matching one pair takes about half a
  // second in the shell; without this every new scan redid all three pairs
  // (about 1.5 s with the interface frozen), and so did a refresh that only
  // lengthened the nowcast.
  property var pairVectors: ({})
  property var gridWaiter: null

  // Final ordered timeline the Panel/PlaybackController consume:
  // { time: ISOString, kind: "observed"|"forecast", png: path-or-null, grid: {cols,rows,values}-or-null }
  property var frames: []
  property int nowIndex: -1 // index of the first "forecast" frame

  property var observedItems: [] // [{id, datetime, pngPath, nowcastGridPath}], time-sorted (7 full-range scans, 60 min)
  // The highest rain-rate cell in the most recent observed radar frame,
  // over the Denmark region. Panel.qml's bar icon falls back to this when
  // there is no nowcast frame to read a peak from, so it doesn't misleadingly
  // read 0.0 while real rain is visible on the map.
  property real lastObservedPeakMm: 0
  property var processedIds: ({}) // set of radar item ids already converted this session

  // DMI's radar scans are HDF5 files that only GDAL reads here: without it
  // there is nothing to show, so say so instead of waiting.
  readonly property string gdalMissingMessage: "GDAL is needed to read DMI's radar scans. Install it with: sudo pacman -S gdal"

  function shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'" }

  function start() {
    mkdirProc.command = ["mkdir", "-p", root.framesDir, root.rawDir]
    mkdirProc.running = true
    gdalCheckProc.command = ["bash", "-c", "command -v gdalinfo"]
    gdalCheckProc.running = true
    refresh()
  }

  function refresh() {
    root.loading = true
    root.errorMessage = ""
    fetchRadarItems()
  }

  // ---- Radar (observed) ----

  function fetchRadarItems() {
    var end = new Date()
    var start = new Date(end.getTime() - 2 * 3600 * 1000)
    var url = RadarModel.buildItemsUrl(MapModel.dmiBbox, start.toISOString(), end.toISOString())
    itemsProc.command = ["curl", "-fsSL", "--max-time", "15", url]
    itemsProc.responseText = ""
    itemsProc.running = true
  }

  property var radarDownloadQueue: []

  function queueRadarDownloads(items) {
    var pending = RadarModel.newItems(items, root.processedIds)
    // Cap how many convert in one pass — only the most recent matter for
    // display, and each conversion costs a few seconds of GDAL work.
    root.radarDownloadQueue = pending.slice(-root.observedScans)
    processRadarQueue()
  }

  function processRadarQueue() {
    if (root.gdalStatus !== "available") return
    if (radarConvertProc.running) return
    if (root.radarDownloadQueue.length === 0) { rebuildObservedFromDisk(); return }
    var item = root.radarDownloadQueue.shift()
    var rawPath = root.rawDir + "/" + item.id + ".h5"
    var outBase = root.framesDir + "/" + item.id
    radarConvertProc.currentItem = item
    radarConvertProc.command = ["curl", "-fsSL", "--max-time", "20", "-o", rawPath, item.downloadUrl]
    radarConvertProc.stage = "download"
    radarConvertProc.rawPath = rawPath
    radarConvertProc.outBase = outBase
    radarConvertProc.running = true
  }

  function rebuildObservedFromDisk() {
    var items = []
    for (var i = 0; i < root.observedItems.length; i++) items.push(root.observedItems[i])
    items.sort(function(a, b) { return a.datetime < b.datetime ? -1 : 1 })
    root.observedItems = items.slice(-root.observedScans)
    root.loading = false
    buildTimeline()
  }

  function updateLastObservedPeak(nowcastGridPath) {
    lastObservedPeakReader.pendingCallback = function(grid) {
      if (!grid || !grid.values) return
      FixedEchoes.fill(grid)
      // Over the Denmark region, not the whole (much larger) map domain —
      // the bar icon is "how hard is it raining around Denmark", and rain
      // over e.g. Poland shouldn't drive it.
      root.lastObservedPeakMm = MapModel.regionPeak(grid, MapModel.denmarkBounds)
    }
    lastObservedPeakReader.path = nowcastGridPath
    lastObservedPeakReader.reload()
  }

  // ---- Timeline assembly ----

  // True once every observed scan has either its grid in memory or a
  // recorded failure to read it.
  function gridsReady() {
    for (var i = 0; i < root.observedItems.length; i++)
      if (root.observedGrids[root.observedItems[i].id] === undefined) return false
    return true
  }

  // Runs `callback` once the observed grids are loaded (at once if they
  // already are). Only the most recent waiter is kept: a newer build
  // supersedes an older one that is still waiting.
  function withObservedGrids(callback) {
    if (gridsReady()) { root.gridWaiter = null; callback(); return }
    root.gridWaiter = callback
  }

  // Fixed echoes are filled here, once per scan, so the motion, the nowcast,
  // the graph, the chance of rain and the map all see the same filled grid.
  function storeObservedGrid(id, grid) {
    root.observedGrids[id] = grid ? FixedEchoes.fill(grid) : false
    root.gridsRevision++
    if (root.gridWaiter && gridsReady()) {
      var waiter = root.gridWaiter
      root.gridWaiter = null
      waiter()
    }
  }

  function pruneObservedGrids() {
    var keep = {}
    for (var i = 0; i < root.observedItems.length; i++) keep[root.observedItems[i].id] = true
    for (var id in root.observedGrids) if (!keep[id]) delete root.observedGrids[id]
    for (var key in root.pairVectors) {
      var ids = key.split("|")
      if (!keep[ids[0]] || !keep[ids[1]]) delete root.pairVectors[key]
    }
  }

  // The observed scans as [{time, grid}] (scans whose grid could not be read
  // are left out), oldest first — the graph's observed series.
  function observedGridSeries() {
    var series = []
    for (var i = 0; i < root.observedItems.length; i++) {
      var grid = root.observedGrids[root.observedItems[i].id]
      if (grid) series.push({ time: root.observedItems[i].datetime, grid: grid })
    }
    return series
  }

  function buildTimeline() {
    if (root.radarDownloadQueue.length > 0 || radarConvertProc.running) return
    pruneObservedGrids()
    withObservedGrids(function() {
      computeRadarNowcast()
      renderTimeline()
    })
  }

  function renderTimeline() {
    var observedFrames = root.observedItems.map(function(it) {
      // observedGrid: the filled grid, which the map paints over the PNG's fixed-echo cells
      return { time: it.datetime, kind: "observed", png: it.pngPath, grid: null, observedGrid: root.observedGrids[it.id] || null }
    })
    buildRadarNowcastTimeline(observedFrames)
  }

  // Our own radar-based nowcast: one motion vector estimated from the last
  // few full-range scans' fine grids, then replayed forward by
  // Interpolation.extrapolateSequence for the whole 2 h horizon (12 steps at
  // the 10-minute full-range cadence; the count follows the actual scan
  // spacing, see Timeline.js). No network call — purely local computation from data
  // already fetched for display. See README for why this exists (DMI's own
  // radar-extrapolation nowcast isn't exposed through the public Open Data
  // API) and its limitations (simple constant-velocity motion, no
  // rotation/growth modeling, accuracy falls quickly with lead time).
  function computeRadarNowcast() {
    var items = root.observedItems
    // Up to the last four full-range scans (30 min) that are loaded and evenly
    // spaced: the motion is estimated over every consecutive pair, not just
    // the last one.
    var run = Timeline.trailingRegularRun(items, motionScans, function(it) { return !!root.observedGrids[it.id] })
    if (run.length < 2) { root.radarNowcast = []; root.radarNowcastKey = ""; root.gridsRevision++; return }
    var gridB = root.observedGrids[run[run.length - 1].id]
    var gridA = root.observedGrids[run[run.length - 2].id]
    var stepMin = Timeline.stepMinutes(run[run.length - 2].datetime, run[run.length - 1].datetime)
    // Far enough to cover the pin's look-ahead from the clock (90 min,
    // PointSeries.HORIZON_MINUTES): the newest scan is normally 13-35 min old,
    // so 11-13 steps. At most 2.5 h after the scan (the research scored the
    // placement to 3 h); a scan older than that leaves the statements short.
    var ageMin = (Date.now() - Date.parse(run[run.length - 1].datetime)) / 60000
    var steps = Timeline.nowcastSteps(stepMin, ageMin, PointSeries.HORIZON_MINUTES, root.maxLeadMinutes)
    // The same scans and length give the same nowcast; a rebuild for any
    // other reason shouldn't redo the block matching.
    var key = run.map(function(it) { return it.id }).join("|") + "#" + steps
    if (key === root.radarNowcastKey && root.radarNowcast.length > 0) return
    // One shared motion vector for the whole map: every block's own match,
    // weighted by match confidence, averaged over the recent scan pairs. Over 176
    // days of radar (Denmark-rain-nowcast report, 5.2, 5.3, B.1), on full-range scans 10
    // minutes apart, it gains +0.209 FSS over "nothing moves" at +60 min; 30
    // minutes of history is the best amount for it. Block matching with one
    // vector per block, averaged over an hour of scans, gains a little more over
    // the map (+0.215) but forecasts more excess rain and is no better at a
    // single city, so the steadier single vector is kept.
    var vectors = []
    for (var p = 0; p + 1 < run.length; p++) {
      var pairKey = run[p].id + "|" + run[p + 1].id
      if (root.pairVectors[pairKey] === undefined)
        root.pairVectors[pairKey] = Interpolation.pairMotion(root.observedGrids[run[p].id], root.observedGrids[run[p + 1].id], 8, 6) || false
      vectors.push(root.pairVectors[pairKey] || null)
    }
    // The same as Interpolation.globalMotionFromFrames over these scans.
    var vector = Interpolation.meanMotion(vectors)
    var grids = Interpolation.extrapolateSequence(gridA, gridB, steps, 8, 6, null, vector || { dx: 0, dy: 0 })
    var times = Timeline.nowcastTimes(run[run.length - 1].datetime, stepMin, steps)
    root.radarNowcastMotion = vector || { dx: 0, dy: 0 }
    var guess = false
    for (var gi = 0; gi < grids.length && !guess; gi++)
      for (var ci = 0; ci < grids[gi].values.length; ci++)
        if (grids[gi].fromEdge[ci] && grids[gi].values[ci] > 0.05) { guess = true; break }
    root.radarNowcastHasEdgeGuess = guess
    root.radarNowcast = grids.map(function(grid, i) { return { time: times[i], grid: grid } })
    root.radarNowcastKey = key
    root.gridsRevision++
  }

  function buildRadarNowcastTimeline(observedFrames) {
    if (root.observedItems.length < 2) {
      root.errorMessage = observedFrames.length === 0
        ? (root.errorMessage || "No data available.")
        : "Need at least two recent radar frames to extrapolate — showing observed radar only."
      root.nowIndex = observedFrames.length
      root.frames = observedFrames
      root.loading = false
      return
    }
    if (root.radarNowcast.length === 0) {
      root.errorMessage = "Could not read radar data for extrapolation — showing observed radar only."
      root.nowIndex = observedFrames.length
      root.frames = observedFrames
      root.loading = false
      return
    }
    var forecastFrames = root.radarNowcast.map(function(step) {
      return { time: step.time, kind: "forecast", png: null, grid: step.grid, motion: root.radarNowcastMotion }
    })
    // Observed scans glide too: each along its own pair's motion (to the next
    // scan), the last along the nowcast's, whose first step is exactly that
    // scan moved one step. Then the next real scan replaces it: every pixel
    // stays a measured value, and the small jump shows what changed.
    for (var i = 0; i < observedFrames.length; i++)
      observedFrames[i].motion = i + 1 < observedFrames.length ? root.observedPairMotion(i) : root.radarNowcastMotion
    root.nowIndex = observedFrames.length
    root.frames = observedFrames.concat(forecastFrames)
    root.errorMessage = ""
    root.loading = false
  }

  // The motion from observed scan i to the next ({dx, dy} grid cells), from the
  // kept pair vectors, computed once for pairs the nowcast never needed; null
  // when either grid is missing or nothing could be measured.
  function observedPairMotion(i) {
    var a = root.observedItems[i], b = root.observedItems[i + 1]
    if (!a || !b || !root.observedGrids[a.id] || !root.observedGrids[b.id]) return null
    var key = a.id + "|" + b.id
    if (root.pairVectors[key] === undefined)
      root.pairVectors[key] = Interpolation.pairMotion(root.observedGrids[a.id], root.observedGrids[b.id], 8, 6) || false
    return root.pairVectors[key] || null
  }

  Component.onCompleted: start()

  Timer {
    interval: root.refreshMinutes * 60 * 1000
    repeat: true
    running: true
    onTriggered: root.refresh()
  }

  Process {
    id: mkdirProc
  }

  Process {
    id: gdalCheckProc
    stdout: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      root.gdalStatus = exitCode === 0 ? "available" : "missing"
      if (root.gdalStatus === "missing") {
        root.errorMessage = root.gdalMissingMessage
        root.loading = false
      } else if (!itemsProc.running) {
        // The scan list may have arrived first, while the queue still waited
        // for this check (processRadarQueue returns until GDAL is known).
        root.processRadarQueue()
      }
    }
  }

  Process {
    id: itemsProc
    property string responseText: ""
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: itemsProc.responseText = text
    }
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root.errorMessage = "Could not reach DMI radar API."
        root.loading = false
        return
      }
      var items = RadarModel.fullRangeOnly(RadarModel.parseItemsResponse(itemsProc.responseText))
      if (root.gdalStatus === "missing") { root.errorMessage = root.gdalMissingMessage; root.loading = false; return }
      root.queueRadarDownloads(items)
    }
  }

  Process {
    id: radarConvertProc
    property var currentItem: null
    property string stage: "download"
    property string rawPath: ""
    property string outBase: ""
    onExited: function(exitCode) {
      if (radarConvertProc.stage === "download") {
        if (exitCode !== 0) { root.processRadarQueue(); return }
        radarConvertProc.stage = "convert"
        radarConvertProc.command = ["bash", root.helperScript, radarConvertProc.rawPath, radarConvertProc.outBase]
        radarConvertProc.running = true
        return
      }
      if (exitCode === 0) {
        root.processedIds[radarConvertProc.currentItem.id] = true
        var items = root.observedItems.slice()
        items.push({
          id: radarConvertProc.currentItem.id,
          datetime: radarConvertProc.currentItem.datetime,
          pngPath: radarConvertProc.outBase + ".png",
          nowcastGridPath: radarConvertProc.outBase + ".nowcast-grid.json"
        })
        root.observedItems = items
        root.updateLastObservedPeak(radarConvertProc.outBase + ".nowcast-grid.json")
      }
      cleanupProc.command = ["rm", "-f", radarConvertProc.rawPath]
      cleanupProc.running = true
      root.processRadarQueue()
    }
  }

  Process { id: cleanupProc }

  // Dedicated to updateLastObservedPeak(), so its reads never interleave
  // with another reader's pendingCallback.
  FileView {
    id: lastObservedPeakReader
    property var pendingCallback: null
    watchChanges: false
    printErrors: false
    onLoaded: {
      var grid = null
      try { grid = JSON.parse(text()) } catch (e) { grid = null }
      var cb = lastObservedPeakReader.pendingCallback
      lastObservedPeakReader.pendingCallback = null
      if (cb) cb(grid)
    }
    onLoadFailed: {
      var cb = lastObservedPeakReader.pendingCallback
      lastObservedPeakReader.pendingCallback = null
      if (cb) cb(null)
    }
  }

  // One FileView per observed scan: each loads its own grid as soon as it
  // exists (no shared reader, so no interleaved reads), and a scan that is
  // already in memory is not read again when the list changes.
  Instantiator {
    model: root.observedItems
    delegate: FileView {
      required property var modelData
      path: root.observedGrids[modelData.id] === undefined ? modelData.nowcastGridPath : ""
      watchChanges: false
      printErrors: false
      onLoaded: {
        var grid = null
        try { grid = JSON.parse(text()) } catch (e) { grid = null }
        root.storeObservedGrid(modelData.id, grid)
      }
      onLoadFailed: root.storeObservedGrid(modelData.id, null)
    }
  }
}
