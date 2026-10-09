pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "MapModel.js" as MapModel
import "LocationModel.js" as LocationModel
import "PointSeries.js" as PointSeries
import "ChanceModel.js" as ChanceModel
import "Towns.js" as Towns
import "MapData.js" as MapData
import "Timeline.js" as Timeline

Panel {
  id: root
  moduleName: "io.github.diegogardini.omarchy-rain-radar-denmark-widget"
  ipcTarget: moduleName
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root
  // Exposed for tests/panel.qml's integration check (ids aren't visible
  // across files without an explicit alias).
  property alias dataService: dataService
  property alias playback: playback

  readonly property int refreshMinutes: Math.max(5, parseInt(setting("refreshMinutes", 10), 10) || 10)
  readonly property bool autoPlay: setting("autoPlay", true) === true || setting("autoPlay", true) === "true"

  // ---- Location for the graph ----
  // The user's own pin (clicked on the map or picked from the city chips,
  // persisted) wins over the Omarchy Weather location; with neither, the
  // graph waits for the user to pick a place. No IP lookup.
  property string stateDir: (Quickshell.env("XDG_STATE_HOME") || Quickshell.env("HOME") + "/.local/state") + "/omarchy/settings"
  property var selection: null
  property var weatherLocation: null
  // "Change place" opens the city chips; picking one (or the map) closes them.
  property bool choosingPlace: false
  // "Search town": a text field with matching Danish places (Towns.js).
  property bool searchingTown: false
  property string townQuery: ""
  readonly property var townMatches: LocationModel.searchTowns(Towns.towns, townQuery, 5)
  function pickTown(m) {
    root.setPin(m.latitude, m.longitude, m.name)
    root.searchingTown = false
    root.townQuery = ""
    root.choosingPlace = false
  }
  // "Use location": the Omarchy weather location; without one, the location
  // detected from the IP address as Omarchy itself does (wttr.in), but only
  // once the user turned "Use location" on (followLocation, saved).
  property bool followLocation: false
  // No place chosen (the ✕, or "Change place" while following): no pin even
  // with an Omarchy weather location, until the user picks one.
  property bool noPlace: false
  property var detectedLocation: null
  property string locationStatus: ""   // "", "locating", or a message why there is no location
  readonly property bool usingLocation: selection === null && !noPlace && (weatherLocation !== null || followLocation)
  readonly property var pin: noPlace ? null : LocationModel.resolve(selection, weatherLocation || (followLocation ? detectedLocation : null))
  function detectLocation() {
    if (root.weatherLocation !== null || locationProc.running) return
    root.locationStatus = "locating"
    locationProc.running = true
  }
  // A click on the map: only Danish land (or within 3 km of its coast) is picked.
  function pickOnMap(latitude, longitude) {
    if (!LocationModel.inDenmark(MapData.denmarkRings, latitude, longitude, 3)) return false
    root.setPin(latitude, longitude)
    root.choosingPlace = false
    return true
  }
  function toggleUseLocation() {
    if (root.usingLocation) {
      // off: keep the place, as a fixed pin
      if (root.pin) root.setPin(root.pin.latitude, root.pin.longitude, root.pin.name)
      root.followLocation = false
    } else if (root.weatherLocation !== null) {
      root.selection = null
      root.followLocation = false
      root.noPlace = false
      root.saveSelection("{}\n")
    } else {
      root.selection = null
      root.noPlace = false
      root.followLocation = true
      root.saveSelection('{"followLocation": true}\n')
      root.detectLocation()
    }
    root.choosingPlace = false
  }
  // The clock the pin's statements count from ("rain in ~20 min"), ticking
  // so the texts and the data's age stay current between scans.
  property real clockMs: Date.now()
  Timer { interval: 30000; running: true; repeat: true; onTriggered: root.clockMs = Date.now() }
  // Minutes since the newest scan's time stamp, or -1 without one. DMI
  // publishes each full-range scan 12-13 min after its time stamp, every
  // 10 min, and the widget polls every 10 min: normally 13 to about 35 min.
  // Older than staleMinutes means at least one scan is missing.
  readonly property int staleMinutes: 45
  readonly property int dataAgeMin: {
    var items = dataService.observedItems
    if (items.length === 0) return -1
    return Math.max(0, Math.round((root.clockMs - Date.parse(items[items.length - 1].datetime)) / 60000))
  }
  readonly property bool dataStale: dataAgeMin > staleMinutes
  readonly property string dataAgeText: {
    if (dataAgeMin < 0) return ""
    var items = dataService.observedItems
    var text = "Radar from " + formatTime(items[items.length - 1].datetime) + " · " + PointSeries.formatLead(dataAgeMin) + " ago"
    return dataStale ? text + " · DMI may be delayed; the nowcast runs from then" : text
  }
  readonly property var pointSeries: {
    var revision = dataService.gridsRevision // re-sample whenever the grids change
    if (!pin) return { points: [], nowMs: null, scanMs: null }
    return PointSeries.build(dataService.observedGridSeries(), dataService.radarNowcast, pin.latitude, pin.longitude, root.clockMs)
  }
  readonly property var pointNowMm: PointSeries.currentMm(pointSeries)
  readonly property bool graphShown: pin !== null && pointSeries.nowMs !== null
  // The chance of rain at the pin: 40 shifted copies of our nowcast (ChanceModel.js).
  readonly property var pointChance: {
    var revision = dataService.gridsRevision
    if (!pin || pointSeries.scanMs === null) return null
    return ChanceModel.compute(dataService.radarNowcast, pin.latitude, pin.longitude, pointSeries.scanMs, undefined, pointSeries.nowMs)
  }
  // The chance of rain within the time the nowcast covers at the pin: the
  // summary says "no rain" only when this is low too.
  readonly property var pointRainChance: pointChance ? ChanceModel.rainWithin(pointChance, PointSeries.coveredMinutes(pointSeries)) : null
  // and when raining, the time by which more rain is under 10% likely
  readonly property var pointDryBy: pointChance ? ChanceModel.dryForGoodBy(pointChance, 1 - PointSeries.NO_RAIN_CHANCE) : undefined
  readonly property string pointSummary: PointSeries.summary(pointSeries, pointRainChance, pointDryBy)
  // The graph's cursor follows playback, gliding between nowcast steps as
  // the map does.
  readonly property real graphCursorMs: {
    var f = playback.currentFrame
    if (!f || !f.time) return -1
    var t = Date.parse(f.time)
    var next = playback.frames[playback.index + 1]
    if (playback.fraction > 0 && next && next.time) t += playback.fraction * (Date.parse(next.time) - t)
    return t
  }

  function setPin(latitude, longitude, name) {
    var place = {
      name: name || LocationModel.nameForPoint(latitude, longitude, Towns.towns),
      latitude: Math.round(latitude * 10000) / 10000,
      longitude: Math.round(longitude * 10000) / 10000
    }
    root.selection = place
    root.followLocation = false
    root.noPlace = false
    root.locationStatus = ""
    root.saveSelection(LocationModel.serializeSelection(place) + "\n")
  }

  // No place: the ✕, and "Change place" while following a location.
  function clearPin() {
    root.selection = null
    root.followLocation = false
    root.noPlace = true
    root.saveSelection('{"noPlace": true}\n')
  }
  function changePlace() {
    if (root.usingLocation) { root.clearPin(); root.choosingPlace = true }
    else root.choosingPlace = !root.choosingPlace
  }

  // The pin file is watched (another tool may change it), so each save comes
  // back as a reload. Two saves in quick succession can bring back the first
  // after the second is already set, so a reload of one of our own older
  // writes is ignored; anything else in the file still applies.
  property var ownWrites: []
  function selectionLoaded(t) {
    var own = root.ownWrites.indexOf(t)
    if (own >= 0 && own < root.ownWrites.length - 1) return // an older save of ours, overtaken
    root.selection = LocationModel.parseSelection(t)
    root.followLocation = LocationModel.followsLocation(t)
    root.noPlace = LocationModel.noPlace(t)
    if (root.followLocation && root.selection === null) root.detectLocation()
  }
  function saveSelection(text) {
    var w = root.ownWrites.slice(-4)
    w.push(text)
    root.ownWrites = w
    selectionFile.setText(text)
  }

  // Jump the map to the frame nearest a time picked on the graph.
  function seekToTime(ms) {
    var best = -1, gap = Infinity
    for (var i = 0; i < playback.frames.length; i++) {
      var t = Date.parse(playback.frames[i].time)
      if (!isFinite(t)) continue
      if (Math.abs(t - ms) < gap) { gap = Math.abs(t - ms); best = i }
    }
    if (best >= 0) { playback.hold(root.holdMs); playback.seek(best) }
  }

  readonly property int holdMs: 4000 // how long a jump holds its frame before playing on
  readonly property var currentFrame: playback.currentFrame
  readonly property real peakMm: {
    var f = (dataService.nowIndex >= 0 && dataService.nowIndex < playback.frames.length) ? playback.frames[dataService.nowIndex] : null
    // Peak over the Denmark region: the nowcast grid now covers the whole
    // (much larger) map, and rain over Poland or the North Sea shouldn't
    // drive the "how hard is it raining around Denmark" number.
    if (f && f.grid) return MapModel.regionPeak(f.grid, MapModel.denmarkBounds)
    // No nowcast frame available (e.g. degraded to observed-only)
    // — fall back to the last real observed frame's peak rather than
    // silently reading 0.0 while there's actually rain on the map.
    return dataService.lastObservedPeakMm
  }
  // With a location set, the icon shows the rain at that spot; without one,
  // the peak over the Denmark region.
  readonly property real barMm: pin && pointNowMm !== null ? pointNowMm : peakMm
  readonly property string barLabel: dataService.converterStatus === "missing" ? "󰼓 —" : "󰖗 " + barMm.toFixed(1)
  readonly property string tooltip: dataService.converterStatus === "missing"
    ? "Rain radar · Denmark (needs Python 3 to read the radar)"
    : (pin && pointNowMm !== null
      ? "Rain radar · " + (pin.name || "Pinned location") + " · " + root.pointSummary
      : "Rain radar · Denmark · peak " + peakMm.toFixed(1) + " mm/h")
      + (dataStale ? " · radar " + PointSeries.formatLead(dataAgeMin) + " old" : "")

  function refresh() { dataService.refresh() }
  function open() { controller.show(); if (root.autoPlay) playback.play() }

  DataService {
    id: dataService
    refreshMinutes: root.refreshMinutes
    onFramesChanged: if (frames.length > 0) playback.index = 0
  }

  PlaybackController {
    id: playback
    frames: dataService.frames
    nowIndex: dataService.nowIndex
    playing: root.autoPlay
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { root.refresh(); return "ok" }
    function setLocation(name: string, latitude: real, longitude: real): string {
      if (!MapModel.contains(latitude, longitude)) return "error: outside the map"
      root.setPin(latitude, longitude, name)
      return "ok"
    }
    function clearLocation(): string { root.clearPin(); return "ok" }
    function pointSeries(): string {
      var s = root.pointSeries
      return JSON.stringify({
        location: root.pin,
        summary: root.pointSummary,
        nowMs: s.nowMs,
        points: s.points.map(function(p) { return { t: new Date(p.ms).toISOString(), mm: Math.round(p.mm * 100) / 100, kind: p.kind } })
      })
    }
    function status(): string {
      return JSON.stringify({
        loading: dataService.loading,
        converterStatus: dataService.converterStatus,
        gdalStatus: dataService.converterStatus, // the former name, kept for scripts until 2.0
        frames: dataService.frames.length,
        nowIndex: dataService.nowIndex,
        peakMm: root.peakMm,
        location: root.pin,
        pointNowMm: root.pointNowMm,
        nowcastSteps: dataService.radarNowcast.length,
        dataAgeMin: root.dataAgeMin,
        dataStale: root.dataStale,
        nowcastEnd: dataService.radarNowcast.length > 0 ? dataService.radarNowcast[dataService.radarNowcast.length - 1].time : "",
        lastObservedPeakMm: dataService.lastObservedPeakMm,
        version: root.version,
        error: dataService.errorMessage
      })
    }
  }

  // The plugin's version, from its own manifest.json (the one place it is
  // written; see CHANGELOG.md): shown in the footer and the IPC status.
  property string version: ""
  FileView {
    id: manifestFile
    path: decodeURIComponent(Qt.resolvedUrl("manifest.json").toString().replace(/^file:\/\//, ""))
    printErrors: false
    onLoaded: {
      try { root.version = JSON.parse(text()).version || "" } catch (e) { root.version = "" }
    }
  }

  FileView {
    id: selectionFile
    path: root.stateDir + "/rain-radar-denmark-location.json"
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.selectionLoaded(text())
    onLoadFailed: root.selection = null
  }

  // The location from the IP address, as Omarchy detects it without a
  // weather.json (wttr.in). Only run for "Use location". Its answer is about
  // 40 kB: curl stops at 1 MB (also mid-transfer), HTTPS only, and anything
  // longer is not parsed, so it can never fill the shell's memory.
  Process {
    id: locationProc
    command: ["curl", "-fsS", "--proto", "=https", "--max-time", "10", "--max-filesize", "1000000", "https://wttr.in/?format=j1"]
    stdout: StdioCollector { id: locationOut; waitForEnd: true }
    onExited: function(exitCode) {
      var text = locationOut.text
      var loc = exitCode === 0 && text.length <= 1000000 ? LocationModel.parseWttrLocation(text) : null
      if (!loc) { root.locationStatus = "Could not find your location (wttr.in did not answer). Pick a place instead."; return }
      if (!LocationModel.inDenmark(MapData.denmarkRings, loc.latitude, loc.longitude, 15)) {
        root.locationStatus = "Your location (" + (loc.name || "unknown") + ") is outside Denmark. Pick a place instead."
        return
      }
      root.detectedLocation = loc
      root.locationStatus = ""
    }
  }

  // Omarchy's own Weather location (`omarchy-weather-location --set`).
  FileView {
    id: weatherFile
    path: root.stateDir + "/weather.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.weatherLocation = LocationModel.parseWeatherLocation(text())
    onLoadFailed: root.weatherLocation = null
  }

  KeyboardPanel {
    id: popup
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: popup.fittedContentWidth(Style.space(460))
    contentHeight: popup.fittedContentHeight(content.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onReturnRequested: playback.toggle()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(text) { if (text.toLowerCase() === "r") root.refresh() }

      Flickable {
        anchors.fill: parent
        contentHeight: content.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        Column {
          id: content
          width: parent.width
          spacing: Style.space(12)

          Item {
            id: mapArea
            width: parent.width
            height: radarMap.fittedHeight

            RadarMap {
              id: radarMap
              anchors.fill: parent
              frame: playback.currentFrame
              observedPngPaths: playback.frames.filter(function(f) { return f.kind === "observed" && f.png }).map(function(f) { return f.png })
              forecastFrames: playback.frames.filter(function(f) { return f.kind === "forecast" && f.grid })
              forecastBadgeText: "PROJECTED"
              // every frame shows its time, to the nearest 10 minutes (the rain
              // still glides on exactly; only the label steps)
              badgeTime: root.graphCursorMs > 0 ? formatTime(new Date(Timeline.shownMs(root.graphCursorMs)).toISOString()) : ""
              fraction: playback.fraction
              pin: root.pin
              pinColor: Color.accent
              onPicked: function(latitude, longitude) { root.pickOnMap(latitude, longitude) }
              foreground: root.barForeground
              background: Color.background
            }

            // The pin's graph, over Sweden in the map's upper right (the view
            // starts at 6 E so Denmark sits left enough to leave it room).
            Rectangle {
              id: graphBox
              readonly property var topLeft: MapModel.project(58.42, 11.9, mapArea.width, mapArea.height)
              readonly property var bottomRight: MapModel.project(56.35, 16.42, mapArea.width, mapArea.height)
              visible: root.graphShown
              x: topLeft.x
              y: topLeft.y
              width: bottomRight.x - topLeft.x
              height: bottomRight.y - topLeft.y
              radius: 6
              color: Util.alpha(Color.background, 0.82)
              border.color: Util.alpha(root.barForeground, 0.18)

              PointGraph {
                id: pointGraph
                anchors.fill: parent
                anchors.margins: 3
                series: root.pointSeries
                chance: root.pointChance ? root.pointChance.steps : []
                cursorMs: root.graphCursorMs
                foreground: root.barForeground
                accent: Color.accent
                fontFamily: Style.font.family
                fontSize: Math.max(8, Style.font.bodySmall - 2)
                onSeek: function(ms) { root.seekToTime(ms) }
              }
            }
          }

          Row {
            width: parent.width
            spacing: Style.space(8)

            // The timeline: click to jump there (held a moment, then it plays on).
            Item {
              id: timeline
              width: parent.width - refreshButton.width - parent.spacing
              height: refreshButton.height
              anchors.verticalCenter: parent.verticalCenter
              MouseArea {
                anchors.fill: parent
                enabled: playback.frames.length > 1
                cursorShape: Qt.PointingHandCursor
                onClicked: function(mouse) {
                  var i = Math.round(mouse.x / timeline.width * (playback.frames.length - 1))
                  playback.hold(root.holdMs)
                  playback.seek(i)
                }
              }

              Rectangle {
                anchors.verticalCenter: parent.verticalCenter
                width: parent.width
                height: 4
                radius: 2
                color: Util.alpha(root.barForeground, 0.15)
              }
              Rectangle {
                visible: playback.frames.length > 1
                anchors.verticalCenter: parent.verticalCenter
                width: parent.width * (playback.position / Math.max(1, playback.frames.length - 1))
                height: 4
                radius: 2
                color: Color.accent
              }
              Rectangle {
                visible: dataService.nowIndex > 0 && playback.frames.length > 1
                anchors.verticalCenter: parent.verticalCenter
                x: parent.width * (dataService.nowIndex / Math.max(1, playback.frames.length - 1)) - width / 2
                width: 2
                height: 12
                color: root.barForeground
              }
            }

            Text {
              id: refreshButton
              text: dataService.loading ? "󰦖" : "󰑐"
              color: root.barForeground
              font.family: Style.font.family
              font.pixelSize: Style.font.title
              anchors.verticalCenter: parent.verticalCenter
              RotationAnimator on rotation {
                running: dataService.loading
                from: 0; to: 360; duration: 800; loops: Animation.Infinite
              }
              TapHandler { enabled: !dataService.loading; onTapped: root.refresh() }
              HoverHandler { cursorShape: Qt.PointingHandCursor }
            }
          }

          Legend {
            width: parent.width
            foreground: root.barForeground
            showEdgeGuess: dataService.radarNowcastHasEdgeGuess
          }

          // The forecast for the place, on a card of its own so it is where the
          // eye goes: the place, what is falling and coming (blue, as the
          // graph's rain line) and the chances (amber, as the graph's strip).
          Rectangle {
            id: forecastCard
            width: parent.width
            height: pointSection.implicitHeight + 2 * Style.space(10)
            radius: 6
            color: Util.alpha(root.barForeground, 0.05)
            border.color: Util.alpha(root.barForeground, 0.10)

            Column {
              id: pointSection
              x: Style.space(10)
              y: Style.space(10)
              width: parent.width - 2 * Style.space(10)
              spacing: Style.space(8)

              Row {
                width: parent.width
                spacing: Style.space(8)
                Column {
                  width: parent.width - (clearButton.visible ? clearButton.width + parent.spacing : 0)
                  - (changePlaceButton.visible ? changePlaceButton.width + parent.spacing : 0)
                  spacing: Style.space(2)
                  Text {
                    width: parent.width
                    elide: Text.ElideRight
                    text: root.pin ? "󰍎  " + (root.pin.name || "Pinned location") : "Rain at a location"
                    color: root.barForeground
                    font.family: Style.font.family
                    font.pixelSize: Style.font.body
                    font.bold: true
                  }
                }
                Text {
                  id: changePlaceButton
                  visible: root.pin !== null
                  anchors.verticalCenter: parent.verticalCenter
                  text: root.choosingPlace ? "Done" : "Change place"
                  color: Util.alpha(root.barForeground, 0.6)
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                  TapHandler { onTapped: root.changePlace() }
                  HoverHandler { cursorShape: Qt.PointingHandCursor }
                }
                Text {
                  id: clearButton
                  visible: root.pin !== null
                  text: "󰅖"
                  color: root.barForeground
                  font.family: Style.font.family
                  font.pixelSize: Style.font.body
                  TapHandler { onTapped: root.clearPin() }
                  HoverHandler { cursorShape: Qt.PointingHandCursor }
                }
              }

              Text {
                width: parent.width
                visible: root.pin !== null
                wrapMode: Text.WordWrap
                text: root.pointSummary
                color: Color.accent
                font.family: Style.font.family
                font.pixelSize: Style.font.body
              }

              // The chances as a small table: the title, then one column per
              // stretch ("Rain within" / "Dry for good by" 30 min · 1 h · 1½ h), the percentage below.
              RowLayout {
                id: chanceTable
                readonly property var parts: ChanceModel.parts(root.pointChance, root.pointNowMm)
                width: parent.width
                visible: root.pin !== null && parts !== null
                spacing: Style.space(8)
                Text {
                  Layout.fillWidth: true
                  Layout.alignment: Qt.AlignVCenter
                  text: chanceTable.parts ? chanceTable.parts.title : ""
                  color: pointGraph.chanceColor
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                }
                Repeater {
                  model: chanceTable.parts ? chanceTable.parts.items : []
                  delegate: Column {
                    id: chanceCell
                    required property var modelData
                    Layout.preferredWidth: Style.space(44)
                    spacing: 0
                    Text {
                      anchors.horizontalCenter: parent.horizontalCenter
                      text: chanceCell.modelData.label
                      color: Util.alpha(root.barForeground, 0.55)
                      font.family: Style.font.family
                      font.pixelSize: Style.font.bodySmall
                    }
                    Text {
                      anchors.horizontalCenter: parent.horizontalCenter
                      text: chanceCell.modelData.percent
                      color: pointGraph.chanceColor
                      font.family: Style.font.family
                      font.pixelSize: Style.font.body
                      font.bold: true
                    }
                  }
                }
              }

              Text {
                // How old the radar is, said only when it is late (normally
                // 13-35 min old: the statements count from the clock anyway).
                width: parent.width
                visible: root.dataStale
                wrapMode: Text.WordWrap
                text: root.dataAgeText
                color: root.dataStale ? Color.urgent : Util.alpha(root.barForeground, 0.55)
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }

              Text {
                width: parent.width
                visible: root.pin === null
                wrapMode: Text.WordWrap
                text: root.locationStatus === "locating" ? "Finding your location…"
                  : root.locationStatus !== "" ? root.locationStatus
                  : "Click the map in Denmark or pick a town to see the rain falling there, and what to expect over the next 90 minutes."
                color: Util.alpha(root.barForeground, 0.6)
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }

              // Places to pick: shown before any place is set, or on "Change place".
              // "Use location" (the Omarchy weather location), the four largest
              // towns, then the search.
              RowLayout {
                width: parent.width
                spacing: Style.space(6)
                visible: (root.pin === null || root.choosingPlace) && !root.searchingTown

                // A toggle: on, the pin follows the Omarchy weather location; off,
                // the place stays where it is as a fixed pin. Dimmed without one.
                Rectangle {
                  id: useLocationChip
                  readonly property bool available: true
                  readonly property bool active: root.usingLocation
                  // every chip stretches, so together they fill the width
                  Layout.fillWidth: true
                  Layout.preferredWidth: useLocationLabel.implicitWidth + Style.space(12)
                  Layout.preferredHeight: useLocationLabel.implicitHeight + Style.space(8)
                  radius: 6
                  opacity: available ? 1 : 0.4
                  color: active ? Color.accent : Util.alpha(root.barForeground, 0.08)
                  border.color: Util.alpha(root.barForeground, 0.2)
                  border.width: active ? 0 : 1
                  Text {
                    id: useLocationLabel
                    anchors.centerIn: parent
                    text: root.locationStatus === "locating" ? "󰖐 Locating…" : "󰖐 Use location"
                    color: useLocationChip.active ? Color.background : root.barForeground
                    font.family: Style.font.family
                    font.pixelSize: Style.font.bodySmall
                  }
                  TapHandler {
                    enabled: useLocationChip.available
                    onTapped: root.toggleUseLocation()
                  }
                  HoverHandler { enabled: useLocationChip.available; cursorShape: Qt.PointingHandCursor }
                }

                Repeater {
                  // the four largest towns, by population (LocationModel.cities starts with them)
                  model: LocationModel.cities.slice(0, 4)
                  delegate: Rectangle {
                    id: chip
                    required property var modelData
                    readonly property bool active: root.selection !== null && root.selection.name === modelData.name
                    Layout.fillWidth: true
                    Layout.preferredWidth: chipLabel.implicitWidth + Style.space(12)
                    Layout.preferredHeight: chipLabel.implicitHeight + Style.space(8)
                    radius: 6
                    color: active ? Color.accent : Util.alpha(root.barForeground, 0.08)
                    border.color: Util.alpha(root.barForeground, 0.2)
                    border.width: active ? 0 : 1
                    Text {
                      id: chipLabel
                      anchors.centerIn: parent
                      text: chip.modelData.name
                      color: chip.active ? Color.background : root.barForeground
                      font.family: Style.font.family
                      font.pixelSize: Style.font.bodySmall
                    }
                    TapHandler { onTapped: { root.setPin(chip.modelData.latitude, chip.modelData.longitude, chip.modelData.name); root.choosingPlace = false } }
                    HoverHandler { cursorShape: Qt.PointingHandCursor }
                  }
                }

                Rectangle {
                  Layout.fillWidth: true
                  Layout.preferredWidth: searchChipLabel.implicitWidth + Style.space(12)
                  Layout.preferredHeight: searchChipLabel.implicitHeight + Style.space(8)
                  radius: 6
                  color: Util.alpha(root.barForeground, 0.08)
                  border.color: Util.alpha(root.barForeground, 0.2)
                  border.width: 1
                  Text {
                    id: searchChipLabel
                    anchors.centerIn: parent
                    text: "󰍉"
                    color: root.barForeground
                    font.family: Style.font.family
                    font.pixelSize: Style.font.bodySmall
                  }
                  TapHandler { onTapped: root.searchingTown = true }
                  HoverHandler { cursorShape: Qt.PointingHandCursor }
                }
              }

              // Town search: type, then Return (the first match) or click a match.
              Column {
                width: parent.width
                spacing: Style.space(4)
                visible: root.searchingTown
                onVisibleChanged: if (visible) townField.forceActiveFocus()

                TextField {
                  id: townField
                  width: parent.width
                  placeholderText: "Danish town or place"
                  foreground: root.barForeground
                  accent: Color.accent
                  font.pixelSize: Style.font.bodySmall
                  text: root.townQuery
                  onTextChanged: root.townQuery = text
                  Keys.onReturnPressed: function(event) { event.accepted = true; if (root.townMatches.length > 0) root.pickTown(root.townMatches[0]) }
                  Keys.onEnterPressed: function(event) { event.accepted = true; if (root.townMatches.length > 0) root.pickTown(root.townMatches[0]) }
                  Keys.onEscapePressed: function(event) { event.accepted = true; root.searchingTown = false; root.townQuery = "" }
                }

                Repeater {
                  model: root.townMatches
                  delegate: Rectangle {
                    id: match
                    required property var modelData
                    required property int index
                    width: parent.width
                    height: matchLabel.implicitHeight + Style.space(8)
                    radius: 4
                    color: matchHover.hovered || index === 0 ? Util.alpha(root.barForeground, 0.08) : "transparent"
                    Text {
                      id: matchLabel
                      anchors.verticalCenter: parent.verticalCenter
                      x: Style.space(8)
                      text: match.modelData.label
                      color: root.barForeground
                      font.family: Style.font.family
                      font.pixelSize: Style.font.bodySmall
                    }
                    TapHandler { onTapped: root.pickTown(match.modelData) }
                    HoverHandler { id: matchHover; cursorShape: Qt.PointingHandCursor }
                  }
                }

                Text {
                  visible: root.townQuery !== "" && root.townMatches.length === 0
                  text: "No Danish place by that name"
                  color: Util.alpha(root.barForeground, 0.55)
                  font.family: Style.font.family
                  font.pixelSize: Style.font.bodySmall
                }
              }
            }
          }

          Text {
            width: parent.width
            visible: dataService.converterStatus === "missing" || (dataService.converterError !== "" && playback.frames.length === 0)
            wrapMode: Text.WordWrap
            text: "⚠ " + (dataService.converterStatus === "missing" ? dataService.converterMissingMessage : dataService.converterError)
            color: Color.urgent
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
          }

          Text {
            // A hard error only when there's genuinely nothing to show —
            // valid frames already on screen shouldn't be undercut by an
            // alarming red banner just because the most recent background
            // refresh attempt (e.g. rate-limited) hasn't landed yet.
            width: parent.width
            visible: dataService.errorMessage !== "" && playback.frames.length === 0 && dataService.converterStatus !== "missing"
            wrapMode: Text.WordWrap
            text: dataService.errorMessage
            color: Color.urgent
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
          }

          Text {
            width: parent.width
            visible: dataService.errorMessage !== "" && playback.frames.length > 0
            wrapMode: Text.WordWrap
            text: "Showing last known data — " + dataService.errorMessage
            color: Util.alpha(root.barForeground, 0.55)
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
          }

          // The credits: a footer below a thin rule, muted, so they never read
          // as part of the forecast. Links underline on hover.
          Column {
            width: parent.width
            spacing: Style.space(6)
            Rectangle { width: parent.width; height: 1; color: Util.alpha(root.barForeground, 0.10) }
            Row {
              spacing: Style.space(6)
              Text {
                text: "Data: DMI"
                color: Util.alpha(root.barForeground, sourceHover.hovered ? 0.8 : 0.45)
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                font.underline: sourceHover.hovered
                TapHandler { onTapped: Quickshell.execDetached(["xdg-open", "https://www.dmi.dk/"]) }
                HoverHandler { id: sourceHover; cursorShape: Qt.PointingHandCursor }
              }
              Text {
                text: "·"
                color: Util.alpha(root.barForeground, 0.3)
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
              Text {
                text: "How does it work?"
                color: Util.alpha(root.barForeground, simulationHover.hovered ? 0.8 : 0.45)
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                font.underline: simulationHover.hovered
                TapHandler { onTapped: Quickshell.execDetached(["xdg-open", "https://diegogardini.github.io/denmark-rain-nowcast/"]) }
                HoverHandler { id: simulationHover; cursorShape: Qt.PointingHandCursor }
              }
              Text {
                text: "·"
                color: Util.alpha(root.barForeground, 0.3)
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
              Text {
                text: "GitHub"
                color: Util.alpha(root.barForeground, repoHover.hovered ? 0.8 : 0.45)
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                font.underline: repoHover.hovered
                TapHandler { onTapped: Quickshell.execDetached(["xdg-open", "https://github.com/diegogardini/omarchy-rain-radar-denmark-widget"]) }
                HoverHandler { id: repoHover; cursorShape: Qt.PointingHandCursor }
              }
              Text {
                visible: root.version !== ""
                text: "· v" + root.version
                color: Util.alpha(root.barForeground, 0.3)
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
              }
            }
          }
        }
      }
    }
  }

  function formatTime(iso) {
    var d = new Date(iso)
    if (isNaN(d.getTime())) return ""
    var pad = function(n) { return (n < 10 ? "0" : "") + n }
    return pad(d.getHours()) + ":" + pad(d.getMinutes())
  }
}
