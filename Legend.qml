pragma ComponentBehavior: Bound
import QtQuick
import "ColorScale.js" as ColorScale

Column {
  id: root
  property color foreground: "#e2e8f0"
  // Show the key for nowcast rain carried in from beyond the map's edge (the
  // radar nowcast only; RadarMap hatches those cells with the same pattern).
  property bool showEdgeGuess: false
  readonly property real maxMm: 60 // legend spans up to "extreme"; ColorScale itself continues beyond this
  spacing: 4

  Canvas {
    id: bar
    width: parent.width
    height: 10
    Connections {
      target: root
      function onWidthChanged() { bar.requestPaint() }
    }
    onPaint: {
      var ctx = getContext("2d")
      ctx.reset()
      var grad = ctx.createLinearGradient(0, 0, width, 0)
      var stops = ColorScale.stops.filter(function(s) { return s.mm <= root.maxMm })
      for (var i = 0; i < stops.length; i++) {
        var s = stops[i]
        var pos = Math.min(1, s.mm / root.maxMm)
        grad.addColorStop(pos, "rgba(" + s.r + "," + s.g + "," + s.b + "," + Math.max(s.a / 255, 0.25) + ")")
      }
      ctx.fillStyle = grad
      var radius = 3
      ctx.beginPath()
      ctx.moveTo(radius, 0)
      ctx.lineTo(width - radius, 0)
      ctx.quadraticCurveTo(width, 0, width, radius)
      ctx.lineTo(width, height - radius)
      ctx.quadraticCurveTo(width, height, width - radius, height)
      ctx.lineTo(radius, height)
      ctx.quadraticCurveTo(0, height, 0, height - radius)
      ctx.lineTo(0, radius)
      ctx.quadraticCurveTo(0, 0, radius, 0)
      ctx.closePath()
      ctx.fill()
    }
  }

  // Three words, each where it is on the bar: light at the start, heavy in
  // its band (15-30 mm/h), extreme at the end.
  Item {
    width: parent.width
    height: lightLabel.implicitHeight
    Text {
      id: lightLabel
      x: 0
      text: "Light"
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.7)
      font.pixelSize: 9
    }
    Text {
      x: parent.width * (22.5 / root.maxMm) - width / 2
      text: "Heavy"
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.7)
      font.pixelSize: 9
    }
    Text {
      x: parent.width - width
      text: "Extreme"
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.7)
      font.pixelSize: 9
    }
  }

  Row {
    visible: root.showEdgeGuess
    spacing: 6
    Canvas {
      id: edgeSwatch
      width: 22
      height: 10
      anchors.verticalCenter: parent.verticalCenter
      Connections {
        target: root
        function onForegroundChanged() { edgeSwatch.requestPaint() }
      }
      onPaint: {
        var ctx = getContext("2d")
        ctx.reset()
        ctx.fillStyle = ctx.createPattern(Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.6), Qt.BDiagPattern)
        ctx.fillRect(0, 0, width, height)
        ctx.strokeStyle = Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.35)
        ctx.lineWidth = 1
        ctx.strokeRect(0.5, 0.5, width - 1, height - 1)
      }
    }
    Text {
      anchors.verticalCenter: parent.verticalCenter
      text: "Rain from beyond the map's edge: a guess (brighter = heavier)"
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.7)
      font.pixelSize: 9
    }
  }
}
