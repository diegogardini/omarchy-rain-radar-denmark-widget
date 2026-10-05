import QtQuick

Item {
  id: root
  property var frames: []
  property int nowIndex: -1
  property int index: 0
  property bool playing: true
  property int frameDurationMs: 350
  // Every frame with a motion (but the last) is shown in `subSteps` stages,
  // its picture moved a little further along the motion each time
  // (RadarMap.fraction), taking as long as one step does without: observed
  // scans glide along their pair's motion until the next real scan replaces
  // them, the nowcast along its own.
  property int subSteps: 7
  property int subIndex: 0

  readonly property var currentFrame: (index >= 0 && index < frames.length) ? frames[index] : null
  readonly property bool atNowBoundary: nowIndex >= 0 && index === nowIndex
  readonly property bool smooth: index < frames.length - 1 && !!(currentFrame && currentFrame.motion)
  // How far the current nowcast step has moved toward the next one, 0 to <1.
  readonly property real fraction: smooth ? subIndex / subSteps : 0
  // Where playback is, in frames, including that fraction: the timeline
  // slider follows this, so it glides with the nowcast too.
  readonly property real position: index + fraction

  function play() { holdTimer.stop(); root.playing = true }
  function pause() { holdTimer.stop(); root.playing = false }
  function toggle() { holdTimer.stop(); root.playing = !root.playing }
  // A jump (a click on the slider or the graph): hold that frame for `ms`,
  // then play on. There is no play button; if playback was already paused
  // (the Return key), it stays paused.
  function hold(ms) {
    if (!root.playing) return
    root.playing = false
    holdTimer.interval = ms
    holdTimer.restart()
  }
  function advance() { root.subIndex = 0; if (root.frames.length > 0) root.index = (root.index + 1) % root.frames.length }
  function tick() {
    if (root.smooth && root.subIndex + 1 < root.subSteps) root.subIndex++
    else root.advance()
  }
  function seek(i) { root.subIndex = 0; root.index = Math.max(0, Math.min(root.frames.length - 1, i)) }

  onFramesChanged: { root.subIndex = 0; if (root.index >= root.frames.length) root.index = 0 }

  Timer {
    id: holdTimer
    repeat: false
    onTriggered: root.playing = true
  }

  Timer {
    // The observed/forecast boundary is already marked visually (dashed
    // border, "FORECAST" badge, timeline tick) — an earlier version also
    // paused playback here for readability, but that read as a stutter
    // rather than a deliberate beat, so the loop just runs continuously.
    interval: root.smooth ? Math.round(root.frameDurationMs / root.subSteps) : root.frameDurationMs
    running: root.playing && root.frames.length > 1
    repeat: true
    onTriggered: root.tick()
  }
}
