import QtQuick
import "MapModel.js" as MapModel
import "MapData.js" as MapData
import "ColorScale.js" as ColorScale
import "FixedEchoes.js" as FixedEchoes

Item {
  id: root
  // { time, kind: "observed"|"forecast", png: path-or-null, grid: {...}-or-null,
  //   observedGrid: an observed scan's filled grid, or absent }
  property var frame: null
  // Every distinct observed-frame PNG path currently in the loop. Preloaded
  // (cache: true) up front rather than loaded on demand as playback reaches
  // each frame — on-demand async loading couldn't keep up with the ~450ms
  // frame interval on a cold cache, so observed frames rendered blank until
  // the loop had gone around once and warmed the cache.
  property var observedPngPaths: []
  property color foreground: "#e2e8f0"
  property color background: "#0c0b0c"
  property string forecastBadgeText: "FORECAST"
  property string observedBadgeText: "PAST"
  // the nowcast's Denmark outline; the pin graph's nowcast line uses the same fine dashes
  readonly property var nowcastDash: [1.5, 2.5]
  // The time shown in the badge (the panel's clock time for this frame).
  property string badgeTime: ""
  // The location the graph is drawn for, {latitude, longitude} or null; shown
  // as a marker. Clicking the map inside its window reports the spot as
  // picked(latitude, longitude) — the owner decides what to do with it.
  property var pin: null
  property color pinColor: "#fbbf24"
  signal picked(real latitude, real longitude)
  readonly property var pinPoint: pin ? MapModel.project(pin.latitude, pin.longitude, width, height) : null
  readonly property bool isForecast: frame && frame.kind === "forecast"
  // Height at which the map domain exactly fills `width` (viewport() keeps
  // an 8px margin on every side), so callers can size the map from its
  // width instead of letterboxing a fixed-height box.
  readonly property real fittedHeight: (width - 16) / MapModel.aspect + 16

  function translucent(color, opacity) { return Qt.rgba(color.r, color.g, color.b, opacity) }

  function imageForPath(path) {
    for (var i = 0; i < imagePool.count; i++) {
      var item = imagePool.itemAt(i)
      if (item && item.modelData === path) return item
    }
    return null
  }

  // The map window in this item's coordinates, and its size.
  readonly property var vp: MapModel.viewport(width, height)
  readonly property real mapW: (MapModel.view.east - MapModel.view.west) * MapModel.longitudeScale * vp.scale
  readonly property real mapH: (MapModel.view.north - MapModel.view.south) * vp.scale
  // Between nowcast steps, how far along the motion the current step's
  // picture is moved (0 to <1; PlaybackController.fraction), and that as a
  // pixel offset: the rain layer moves, nothing is repainted.
  property real fraction: 0
  readonly property var motionShift: {
    var f = root.frame
    var g = f ? (f.grid || f.observedGrid) : null
    if (!f || !f.motion || !g || root.fraction <= 0) return { x: 0, y: 0 }
    var cellW = (g.bounds.east - g.bounds.west) / g.cols * MapModel.longitudeScale * root.vp.scale
    var cellH = (g.bounds.north - g.bounds.south) / g.rows * root.vp.scale
    return { x: root.fraction * f.motion.dx * cellW, y: root.fraction * f.motion.dy * cellH }
  }

  function traceRings(ctx, rings) {
    ctx.beginPath()
    for (var i = 0; i < rings.length; i++) {
      var ring = rings[i]
      for (var k = 0; k < ring.length; k++) {
        var p = MapModel.project(ring[k][1], ring[k][0], root.width, root.height)
        if (k === 0) ctx.moveTo(p.x, p.y)
        else ctx.lineTo(p.x, p.y)
      }
      ctx.closePath()
    }
  }

  function neighbourRings() {
    var rings = []
    for (var i = 0; i < MapData.neighbours.length; i++) rings = rings.concat(MapData.neighbours[i].rings)
    return rings
  }

  function drawObservedImage(ctx, image) {
    // the radar image covers the whole data area, which reaches past the view
    var vp = MapModel.viewport(root.width, root.height)
    var w = (MapModel.bounds.east - MapModel.bounds.west) * MapModel.longitudeScale * vp.scale
    var h = (MapModel.bounds.north - MapModel.bounds.south) * vp.scale
    var corner = MapModel.project(MapModel.bounds.north, MapModel.bounds.west, root.width, root.height)
    ctx.drawImage(image, corner.x, corner.y, w, h)
  }

  // Where a grid's cells land on the canvas.
  function gridGeometry(grid) {
    var vp = MapModel.viewport(root.width, root.height)
    var cellLon = (grid.bounds.east - grid.bounds.west) / grid.cols
    var cellLat = (grid.bounds.north - grid.bounds.south) / grid.rows
    var cellW = cellLon * MapModel.longitudeScale * vp.scale
    var cellH = cellLat * vp.scale
    // Cells tile the grid's own bounds exactly (origin + index * size),
    // so neighbours abut without seams and need only a small
    // *proportional* overlap to hide anti-aliasing hairlines. (An
    // earlier flat +1px was ~2.4x each ~1.8px cell's area, which read
    // as "thicker" rain than the observed PNG.) A grid may cover only
    // part of the map, hence the offset from the map's own origin.
    var drawW = cellW * 1.15
    var drawH = cellH * 1.15
    return {
      x0: vp.x + (grid.bounds.west - MapModel.view.west) * MapModel.longitudeScale * vp.scale,
      y0: vp.y + (MapModel.view.north - grid.bounds.north) * vp.scale,
      cellW: cellW, cellH: cellH, drawW: drawW, drawH: drawH,
      padX: (drawW - cellW) / 2, padY: (drawH - cellH) / 2
    }
  }

  // Nowcast cells whose rain came in from beyond the map's edge (the edge
  // value repeated, a helpful guess: research #29) are hatched in the
  // theme's foreground colour instead of the rain palette, brighter for
  // heavier rain: light, moderate, heavy or more (the legend's words).
  function edgeGuessPatterns(ctx) {
    return [0.35, 0.6, 0.9].map(function(opacity) {
      return ctx.createPattern(root.translucent(root.foreground, opacity), Qt.BDiagPattern)
    })
  }
  function edgeGuessLevel(value) { return value < 4 ? 0 : (value < 15 ? 1 : 2) }

  function drawCell(ctx, grid, geo, row, col, edgePatterns) {
    var idx = row * grid.cols + col
    var value = grid.values[idx]
    if (value <= 0.05) return
    var guessed = edgePatterns && grid.fromEdge && grid.fromEdge[idx]
    ctx.fillStyle = guessed ? edgePatterns[edgeGuessLevel(value)] : ColorScale.cssColorAt(value)
    if (guessed) ctx.fillRect(geo.x0 + col * geo.cellW, geo.y0 + row * geo.cellH, geo.cellW, geo.cellH)
    else ctx.fillRect(geo.x0 + col * geo.cellW - geo.padX, geo.y0 + row * geo.cellH - geo.padY, geo.drawW, geo.drawH)
  }

  function drawGrid(ctx, grid) {
    var geo = gridGeometry(grid)
    var edgePatterns = grid.fromEdge ? edgeGuessPatterns(ctx) : null
    for (var row = 0; row < grid.rows; row++)
      for (var col = 0; col < grid.cols; col++) drawCell(ctx, grid, geo, row, col, edgePatterns)
  }

  // An observed scan: the PNG, except at the fixed-echo cells, which are
  // painted from the scan's filled grid (FixedEchoes.js) so the map shows
  // what the graph and the nowcast use. The cells are cut out of the clip
  // as holes (wound the other way round from the map rectangle).
  function drawObserved(ctx, image, grid) {
    if (!grid || !FixedEchoes.applies(grid)) { drawObservedImage(ctx, image); return }
    var vp = MapModel.viewport(root.width, root.height)
    var geo = gridGeometry(grid)
    var cells = FixedEchoes.CELLS
    ctx.save()
    ctx.beginPath()
    ctx.rect(vp.x, vp.y, root.mapW, root.mapH)
    for (var i = 0; i < cells.length; i++) {
      var x = geo.x0 + cells[i][1] * geo.cellW, y = geo.y0 + cells[i][0] * geo.cellH
      ctx.moveTo(x, y)
      ctx.lineTo(x, y + geo.cellH)
      ctx.lineTo(x + geo.cellW, y + geo.cellH)
      ctx.lineTo(x + geo.cellW, y)
      ctx.closePath()
    }
    ctx.clip()
    drawObservedImage(ctx, image)
    ctx.restore()
    for (var k = 0; k < cells.length; k++) drawCell(ctx, grid, geo, cells[k][0], cells[k][1])
  }

  Rectangle {
    anchors.fill: parent
    color: root.background
    radius: 8
    clip: true

    Repeater {
      id: imagePool
      model: root.observedPngPaths
      delegate: Image {
        id: poolImage
        required property string modelData
        visible: false
        asynchronous: true
        cache: true
        source: "file://" + modelData
        onStatusChanged: if (status === Image.Ready) rainLayer.requestPaint()
      }
    }

    // Three layers, so a smooth nowcast never repaints anything: the land
    // (painted on resize or a theme change), the rain (painted once per frame,
    // and moved by a fraction of the motion between nowcast steps) and the
    // coastlines and border over it.
    Canvas {
      id: landLayer
      anchors.fill: parent
      onWidthChanged: requestPaint()
      onHeightChanged: requestPaint()
      Connections {
        target: root
        function onForegroundChanged() { landLayer.requestPaint() }
      }
      onPaint: {
        var ctx = getContext("2d")
        ctx.reset()
        var vp = root.vp
        ctx.save()
        ctx.beginPath()
        ctx.rect(vp.x, vp.y, root.mapW, root.mapH)
        ctx.clip()
        // Land under the rain, Denmark a touch brighter than its neighbours.
        root.traceRings(ctx, root.neighbourRings())
        ctx.fillStyle = root.translucent(root.foreground, 0.045)
        ctx.fill()
        root.traceRings(ctx, MapData.denmarkRings)
        ctx.fillStyle = root.translucent(root.foreground, 0.08)
        ctx.fill()
        ctx.restore()
      }
    }

    // Everything is clipped to the map window (not to Denmark: rain has to be
    // visible over the sea and the neighbouring countries too).
    Item {
      id: rainWindow
      x: root.vp.x
      y: root.vp.y
      width: root.mapW
      height: root.mapH
      clip: true
      Canvas {
        id: rainLayer
        x: -root.vp.x + root.motionShift.x
        y: -root.vp.y + root.motionShift.y
        width: root.width
        height: root.height
        onWidthChanged: requestPaint()
        onHeightChanged: requestPaint()
        Connections {
          target: root
          function onFrameChanged() { rainLayer.requestPaint() }
          function onForegroundChanged() { rainLayer.requestPaint() }
        }
        onPaint: {
          var ctx = getContext("2d")
          ctx.reset()
          if (!root.frame) return
          ctx.globalAlpha = root.isForecast ? 0.85 : 1.0
          var observedImage = (root.frame.kind === "observed" && root.frame.png) ? root.imageForPath(root.frame.png) : null
          if (observedImage && observedImage.status === Image.Ready) root.drawObserved(ctx, observedImage, root.frame.observedGrid)
          else if (root.frame.grid) root.drawGrid(ctx, root.frame.grid)
          ctx.globalAlpha = 1.0
        }
      }
    }

    Canvas {
      id: coastLayer
      anchors.fill: parent
      onWidthChanged: requestPaint()
      onHeightChanged: requestPaint()
      Connections {
        target: root
        function onForegroundChanged() { coastLayer.requestPaint() }
        function onIsForecastChanged() { coastLayer.requestPaint() }
      }
      onPaint: {
        var ctx = getContext("2d")
        ctx.reset()
        var vp = root.vp
        var neighbours = root.neighbourRings()
        ctx.save()
        ctx.beginPath()
        ctx.rect(vp.x, vp.y, root.mapW, root.mapH)
        ctx.clip()
        // Coastlines over the rain so it never hides them.
        ctx.setLineDash([])
        root.traceRings(ctx, neighbours)
        ctx.strokeStyle = root.translucent(root.foreground, 0.3)
        ctx.lineWidth = 0.8
        ctx.stroke()
        root.traceRings(ctx, MapData.denmarkRings)
        ctx.strokeStyle = root.translucent(root.foreground, 0.75)
        ctx.lineWidth = 1.2
        if (root.isForecast) ctx.setLineDash(root.nowcastDash)
        ctx.stroke()
        ctx.restore()
        ctx.strokeStyle = root.translucent(root.foreground, 0.14)
        ctx.lineWidth = 1
        ctx.strokeRect(vp.x, vp.y, root.mapW, root.mapH)
      }
    }

    Repeater {
      model: MapData.labels
      delegate: Text {
        id: countryLabel
        required property var modelData
        readonly property var point: MapModel.project(modelData.lat, modelData.lon, root.width, root.height)
        x: point.x - width / 2
        y: point.y - height / 2
        text: modelData.name
        color: root.translucent(root.foreground, 0.4)
        font.pixelSize: 9
        font.letterSpacing: 0.5
      }
    }

    // Bottom left, over the North Sea: the upper right is the pin's graph.
    Rectangle {
      visible: root.frame !== null
      anchors.bottom: parent.bottom
      anchors.left: parent.left
      anchors.margins: 8
      radius: 4
      color: root.translucent(root.background, 0.75)
      border.color: root.translucent(root.foreground, 0.35)
      width: forecastLabel.implicitWidth + 12
      height: forecastLabel.implicitHeight + 6
      Text {
        id: forecastLabel
        anchors.centerIn: parent
        text: (root.isForecast ? root.forecastBadgeText : root.observedBadgeText) + (root.badgeTime ? "  " + root.badgeTime : "")
        font.pixelSize: 9
        font.bold: true
        font.letterSpacing: 1
        color: root.foreground
      }
    }
  }

  // Zero-size anchor at the pin's position; the marker is drawn around it.
  Item {
    id: pinMarker
    visible: root.pin !== null && MapModel.inView(root.pin.latitude, root.pin.longitude)
    x: root.pinPoint ? root.pinPoint.x : 0
    y: root.pinPoint ? root.pinPoint.y : 0
    Rectangle {
      x: -13; y: -13; width: 26; height: 26; radius: 13
      color: root.translucent(root.pinColor, 0.18)
      border.color: root.translucent(root.pinColor, 0.6)
      border.width: 1
    }
    Rectangle {
      x: -5; y: -5; width: 10; height: 10; radius: 5
      color: root.pinColor
      border.color: root.background
      border.width: 2
    }
  }

  TapHandler {
    onTapped: function(eventPoint) {
      var p = MapModel.unproject(eventPoint.position.x, eventPoint.position.y, root.width, root.height)
      if (p && MapModel.inView(p.latitude, p.longitude)) root.picked(p.latitude, p.longitude)
    }
  }
  HoverHandler { cursorShape: Qt.CrossCursor }
}
